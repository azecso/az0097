import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, roundMoney } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { consumeFifo, inventoryAccountOf, receiveLot, restoreConsumptions } from "../inventory";
import { dateStr, draftRef, moneyStr, qtyStr, toBaseQty, uuid, yearOf } from "./common";

const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const stamp = (date: string) => `${date}T${new Date().toISOString().slice(11, 19)}Z`;

// ======================= internal transfers (main <-> partner custody) =======================
export const transferSchema = z.object({
  docDate: dateStr, fromLocationId: uuid, toLocationId: uuid, notes: z.string().max(500).nullish(),
  lines: z.array(z.object({ productId: uuid, uom: z.string().min(1).max(30), qty: qtyStr })).min(1).max(200),
});

export async function createTransfer(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof transferSchema>) {
  if (i.fromLocationId === i.toLocationId) throw badRequest("SAME_LOCATION", "موقع المصدر والوجهة متطابقان");
  const locs = await tx`SELECT id FROM stock_locations WHERE id IN ${tx([i.fromLocationId, i.toLocationId])}`;
  if (locs.length !== 2) throw badRequest("LOCATION_NOT_FOUND");
  if (new Set(i.lines.map((l) => l.productId)).size !== i.lines.length) throw badRequest("DUPLICATE_PRODUCT", "المادة مكررة في التحويل");
  const [h] = await tx`INSERT INTO stock_transfers(company_id, draft_ref, doc_date, from_location_id, to_location_id, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.fromLocationId}, ${i.toLocationId}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  let n = 0;
  for (const l of i.lines) {
    n += 1;
    await tx`INSERT INTO stock_transfer_lines(company_id, transfer_id, line_no, product_id, uom, qty, qty_base) VALUES (${who.companyId}, ${h!.id}, ${n}, ${l.productId}, ${l.uom}, ${l.qty}, ${await toBaseQty(tx, l.productId, l.uom, l.qty)})`;
  }
  await audit(tx, actor, { action: "stock_transfer.create_draft", entityType: "stock_transfer", entityId: h!.id, after: i });
  return h!;
}

export async function deleteTransferDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM stock_transfers WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM stock_transfer_lines WHERE transfer_id = ${id}`;
  await tx`DELETE FROM stock_transfers WHERE id = ${id}`;
  await audit(tx, actor, { action: "stock_transfer.delete_draft", entityType: "stock_transfer", entityId: id });
}

export async function listTransfers(tx: Tx) {
  return tx`SELECT t.id, t.draft_ref AS "draftRef", t.doc_no AS "docNo", t.doc_date::text AS "docDate", fl.name AS "from", tl.name AS "to", t.status
    FROM stock_transfers t JOIN stock_locations fl ON fl.id = t.from_location_id JOIN stock_locations tl ON tl.id = t.to_location_id ORDER BY t.doc_date DESC, t.created_at DESC LIMIT 200`;
}

/** No revenue, no COGS: only cost moves between the two inventory accounts, layer by layer, keeping original receipt dates and costs. */
export async function postTransfer(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [t] = await tx`SELECT * FROM stock_transfers WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const date = dateOf(t.doc_date);
  const lines = await tx`SELECT * FROM stock_transfer_lines WHERE transfer_id = ${id} ORDER BY product_id`;     // stable lock order
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'stock_transfer', ${yearOf(date)}) AS n`)[0]!.n as string;
  let total = d(0);
  for (const l of lines) {
    const out = await consumeFifo(tx, who.companyId, { productId: l.product_id, locationId: t.from_location_id, qtyBase: l.qty_base, type: "TRANSFER_OUT", docType: "stock_transfer", docId: id, docLineId: l.id, at: new Date() });
    for (const p of out.parts) {
      await receiveLot(tx, who.companyId, { productId: l.product_id, locationId: t.to_location_id, originDocType: "stock_transfer", originDocId: id, originLineId: l.id,
        receivedAt: p.lot.received_at, qtyBase: p.qty, totalCostBase: p.cost, unitCostOrig: p.lot.unit_cost_orig, currency: p.lot.currency, fx: p.lot.fx_rate_snapshot, sourceLotId: p.lot.id, movement: "TRANSFER_IN" });
    }
    await tx`UPDATE stock_transfer_lines SET cost_base = ${out.cost.toString()} WHERE id = ${l.id}`;
    total = total.plus(out.cost);
  }
  const from = await inventoryAccountOf(tx, t.from_location_id), to = await inventoryAccountOf(tx, t.to_location_id);
  let je: string | null = null;
  if (from !== to && total.gt(0)) je = await postJournal(tx, actor, { date, sourceDocType: "stock_transfer", sourceDocId: id, memo: `تحويل مخزون ${docNo}`, lines: [{ account: to, debit: total }, { account: from, credit: total }] });
  const [h] = await tx`UPDATE stock_transfers SET status = 'POSTED', doc_no = ${docNo}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "stock_transfer.post", entityType: "stock_transfer", entityId: id, after: { docNo, cost: total.toString() } });
  return { ...h!, costBase: total.toString() };
}

export async function reverseTransfer(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [t] = await tx`SELECT * FROM stock_transfers WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "POSTED") throw conflict("NOT_POSTED");
  const dest = await tx`SELECT id, qty_received::text, qty_remaining::text, total_cost_base::text, product_id, location_id FROM stock_lots WHERE origin_doc_type = 'stock_transfer' AND origin_doc_id = ${id} FOR UPDATE`;
  if (dest.some((l) => !d(l.qty_remaining).eq(l.qty_received))) throw conflict("TRANSFERRED_STOCK_MOVED", "جزء من البضاعة المنقولة بيع أو نُقل لاحقاً؛ اعكس تلك الحركات أولاً");
  await restoreConsumptions(tx, who.companyId, "stock_transfer", id, new Date());
  for (const l of dest) {
    await tx`UPDATE stock_lots SET qty_remaining = 0, cost_remaining_base = 0 WHERE id = ${l.id}`;
    await tx`INSERT INTO stock_movements(company_id, product_id, location_id, lot_id, movement_type, qty_base, cost_base, doc_type, doc_id, moved_at)
      VALUES (${who.companyId}, ${l.product_id}, ${l.location_id}, ${l.id}, 'REVERSAL', ${d(l.qty_received).neg().toString()}, ${d(l.total_cost_base).neg().toString()}, 'stock_transfer', ${id}, now())`;
  }
  if (t.journal_entry_id) await reverseEntry(tx, actor, t.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس تحويل ${t.doc_no}: ${reason}`);
  await tx`UPDATE stock_transfers SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "stock_transfer.reverse", entityType: "stock_transfer", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// ======================= physical count / adjustments =======================
export const countSchema = z.object({
  docDate: dateStr, locationId: uuid, reason: z.string().min(3).max(500),
  lines: z.array(z.object({ productId: uuid, countedQtyBase: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/), unitCostBase: moneyStr.nullish() })).min(1).max(500),
});

export async function createCount(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof countSchema>) {
  if (new Set(i.lines.map((l) => l.productId)).size !== i.lines.length) throw badRequest("DUPLICATE_PRODUCT");
  const [h] = await tx`INSERT INTO inventory_counts(company_id, draft_ref, doc_date, location_id, reason, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.locationId}, ${i.reason}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  for (const l of i.lines)
    await tx`INSERT INTO inventory_count_lines(company_id, count_id, product_id, counted_qty_base, unit_cost_base) VALUES (${who.companyId}, ${h!.id}, ${l.productId}, ${l.countedQtyBase}, ${l.unitCostBase ?? null})`;
  await audit(tx, actor, { action: "inventory_count.create_draft", entityType: "inventory_count", entityId: h!.id, after: i });
  return h!;
}

export async function deleteCountDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM inventory_counts WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM inventory_count_lines WHERE count_id = ${id}`;
  await tx`DELETE FROM inventory_counts WHERE id = ${id}`;
  await audit(tx, actor, { action: "inventory_count.delete_draft", entityType: "inventory_count", entityId: id });
}

export async function listCounts(tx: Tx) {
  return tx`SELECT c.id, c.draft_ref AS "draftRef", c.doc_no AS "docNo", c.doc_date::text AS "docDate", l.name AS location, c.reason, c.status
    FROM inventory_counts c JOIN stock_locations l ON l.id = c.location_id ORDER BY c.doc_date DESC, c.created_at DESC LIMIT 200`;
}

/** Shortage => FIFO outflow (Dr 5200 / Cr inventory). Surplus => new layer at an EXPLICIT unit cost (Dr inventory / Cr 5200). */
export async function postCount(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [c] = await tx`SELECT * FROM inventory_counts WHERE id = ${id} FOR UPDATE`;
  if (!c) throw notFound();
  if (c.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const date = dateOf(c.doc_date);
  const lines = await tx`SELECT * FROM inventory_count_lines WHERE count_id = ${id} ORDER BY product_id`;
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'inventory_count', ${yearOf(date)}) AS n`)[0]!.n as string;
  const invAcct = await inventoryAccountOf(tx, c.location_id);
  let shortage = d(0), surplus = d(0);
  for (const l of lines) {
    const sys = d((await tx`SELECT COALESCE(sum(qty_remaining), 0)::text AS q FROM stock_lots WHERE product_id = ${l.product_id} AND location_id = ${c.location_id}`)[0]!.q);
    const diff = d(l.counted_qty_base).minus(sys);
    let signedCost = d(0);
    if (diff.lt(0)) {
      const out = await consumeFifo(tx, who.companyId, { productId: l.product_id, locationId: c.location_id, qtyBase: diff.abs(), type: "COUNT_ADJ", docType: "inventory_count", docId: id, docLineId: l.id, at: new Date() });
      signedCost = out.cost.neg(); shortage = shortage.plus(out.cost);
    } else if (diff.gt(0)) {
      if (l.unit_cost_base === null) throw badRequest("SURPLUS_NEEDS_UNIT_COST", "الزيادة في الجرد تتطلب تكلفة وحدة صريحة");
      const total = roundMoney(diff.mul(l.unit_cost_base), "IQD");
      await receiveLot(tx, who.companyId, { productId: l.product_id, locationId: c.location_id, originDocType: "inventory_count", originDocId: id, originLineId: l.id,
        receivedAt: stamp(date), qtyBase: diff, totalCostBase: total, unitCostOrig: l.unit_cost_base, currency: "IQD", fx: "1", movement: "COUNT_ADJ" });
      signedCost = total; surplus = surplus.plus(total);
    }
    await tx`UPDATE inventory_count_lines SET system_qty_base = ${sys.toString()}, diff_cost_base = ${signedCost.toString()} WHERE id = ${l.id}`;
  }
  const jl: JLine[] = [];
  if (shortage.gt(0)) { jl.push({ account: "5200", debit: shortage }, { account: invAcct, credit: shortage }); }
  if (surplus.gt(0)) { jl.push({ account: invAcct, debit: surplus }, { account: "5200", credit: surplus }); }
  const je = jl.length ? await postJournal(tx, actor, { date, sourceDocType: "inventory_count", sourceDocId: id, memo: `جرد ${docNo}: ${c.reason}`, lines: jl }) : null;
  const [h] = await tx`UPDATE inventory_counts SET status = 'POSTED', doc_no = ${docNo}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "inventory_count.post", entityType: "inventory_count", entityId: id, after: { docNo, shortage: shortage.toString(), surplus: surplus.toString() } });
  return { ...h!, shortageBase: shortage.toString(), surplusBase: surplus.toString() };
}
void Decimal;
