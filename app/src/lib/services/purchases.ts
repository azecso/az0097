import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { reverseCashMovements } from "./cash";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { d, roundMoney, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { consumeFromLots, inventoryAccountOf, lotFamily, receiveLot, retireLots } from "../inventory";
import { assertCashAvailable } from "./cash";
import { currencyCode, dateStr, draftRef, mainLocationId, moneyStr, qtyStr, rateStr, resolveRate, toBaseQty, uuid, yearOf } from "./common";

const stamp = (date: string) => `${date}T${new Date().toISOString().slice(11, 19)}Z`;   // keeps same-day FIFO order = posting order

// ======================= purchase invoice (+ goods receipt) =======================
export const purchaseSchema = z.object({
  supplierId: uuid, docDate: dateStr, paymentType: z.enum(["CASH", "CREDIT"]), cashAccountId: uuid.nullish(), dueDate: dateStr.nullish(),
  currency: currencyCode, exchangeRate: rateStr.nullish(), supplierInvoiceNo: z.string().max(60).nullish(), notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({ productId: uuid, uom: z.string().min(1).max(30), qty: qtyStr, unitPrice: moneyStr, locationId: uuid.nullish(), profitClass: z.enum(["PARTNERSHIP", "USED"]).default("PARTNERSHIP") })).min(1).max(200),
  // Extra costs billed with the invoice. capitalize=true adds them to the inventory cost of THIS purchase's layers; false expenses them.
  // When omitted, the company policy (landed_cost_policy) decides.
  charges: z.array(z.object({ kind: z.enum(["TRANSPORT", "LOADING", "CUSTOMS", "OTHER"]), description: z.string().max(200).nullish(), amount: moneyStr, capitalize: z.boolean().nullish() })).max(20).default([]),
});
export const purchaseUpdateSchema = purchaseSchema.extend({ version: z.number().int() });

async function prepare(tx: Tx, i: z.infer<typeof purchaseSchema>) {
  const [s] = await tx`SELECT kind, is_archived FROM contacts WHERE id = ${i.supplierId}`;
  if (!s || s.kind === "CUSTOMER") throw badRequest("NOT_A_SUPPLIER", "الجهة المختارة ليست مورداً");
  if (s.is_archived) throw conflict("SUPPLIER_ARCHIVED", "المورد مؤرشف");
  if (i.paymentType === "CASH") {
    if (!i.cashAccountId) throw badRequest("CASH_ACCOUNT_REQUIRED", "اختر الصندوق للشراء النقدي");
    const [c] = await tx`SELECT currency, kind FROM cash_accounts WHERE id = ${i.cashAccountId} AND is_active`;
    if (!c || c.kind === "PARTNER_CUSTODY") throw badRequest("BAD_CASH_ACCOUNT");
    if (c.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق عملة الفاتورة");
  }
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const main = await mainLocationId(tx);
  const lines = [];
  for (const l of i.lines) {
    const qtyBase = await toBaseQty(tx, l.productId, l.uom, l.qty);
    const lineTotal = roundMoney(d(l.qty).mul(l.unitPrice), i.currency);
    lines.push({ ...l, qtyBase, lineTotal: lineTotal.toString(), locationId: l.locationId ?? main });
  }
  const [co] = await tx`SELECT landed_cost_policy FROM companies LIMIT 1`;
  const charges = i.charges.map((c) => {
    if (d(c.amount).lte(0)) throw badRequest("INVALID_CHARGE");
    return { kind: c.kind, description: c.description ?? null, amount: roundMoney(c.amount, i.currency).toString(), capitalize: c.capitalize ?? co!.landed_cost_policy === "INCLUDE" };
  });
  const total = lines.reduce((s, l) => s.plus(l.lineTotal), d(0)).plus(charges.reduce((s, c) => s.plus(c.amount), d(0)));
  return { rate, lines, charges, total };
}

async function writeCharges(tx: Tx, companyId: string, id: string, charges: Awaited<ReturnType<typeof prepare>>["charges"]) {
  await tx`DELETE FROM purchase_charges WHERE purchase_id = ${id}`;
  let n = 0;
  for (const c of charges) { n += 1; await tx`INSERT INTO purchase_charges(company_id, purchase_id, line_no, kind, description, amount, capitalize) VALUES (${companyId}, ${id}, ${n}, ${c.kind}, ${c.description}, ${c.amount}, ${c.capitalize})`; }
}

async function writeLines(tx: Tx, companyId: string, id: string, lines: Awaited<ReturnType<typeof prepare>>["lines"]) {
  await tx`DELETE FROM purchase_lines WHERE purchase_id = ${id}`;
  let n = 0;
  for (const l of lines) {
    n += 1;
    await tx`INSERT INTO purchase_lines(company_id, purchase_id, line_no, product_id, uom, qty, qty_base, unit_price, line_total, location_id, profit_class)
      VALUES (${companyId}, ${id}, ${n}, ${l.productId}, ${l.uom}, ${l.qty}, ${l.qtyBase}, ${l.unitPrice}, ${l.lineTotal}, ${l.locationId}, ${l.profitClass})`;
  }
}

export async function createPurchase(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof purchaseSchema>) {
  const p = await prepare(tx, i);
  const [h] = await tx`INSERT INTO purchase_orders(company_id, draft_ref, doc_date, supplier_id, supplier_invoice_no, payment_type, cash_account_id, due_date, currency, exchange_rate_snapshot, total, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.supplierId}, ${i.supplierInvoiceNo ?? null}, ${i.paymentType}, ${i.paymentType === "CASH" ? i.cashAccountId! : null}, ${i.dueDate ?? null},
            ${i.currency}, ${p.rate}, ${p.total.toString()}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await writeLines(tx, who.companyId, h!.id, p.lines);
  await writeCharges(tx, who.companyId, h!.id, p.charges);
  await audit(tx, actor, { action: "purchase.create_draft", entityType: "purchase_order", entityId: h!.id, after: { total: p.total.toString(), currency: i.currency } });
  return h!;
}

export async function updatePurchase(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof purchaseUpdateSchema>) {
  const [cur] = await tx`SELECT * FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "لا يمكن تعديل مستند غير مسودة");
  if (cur.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل المسودة من جهة أخرى");
  const p = await prepare(tx, i);
  await writeLines(tx, who.companyId, id, p.lines);
  await writeCharges(tx, who.companyId, id, p.charges);
  const [h] = await tx`UPDATE purchase_orders SET doc_date = ${i.docDate}, supplier_id = ${i.supplierId}, supplier_invoice_no = ${i.supplierInvoiceNo ?? null}, payment_type = ${i.paymentType},
      cash_account_id = ${i.paymentType === "CASH" ? i.cashAccountId! : null}, due_date = ${i.dueDate ?? null}, currency = ${i.currency}, exchange_rate_snapshot = ${p.rate},
      total = ${p.total.toString()}, notes = ${i.notes ?? null}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, version`;
  await audit(tx, actor, { action: "purchase.update_draft", entityType: "purchase_order", entityId: id, before: { total: cur.total }, after: { total: p.total.toString() } });
  return h!;
}

export async function deletePurchaseDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM purchase_lines WHERE purchase_id = ${id}`;
  await tx`DELETE FROM purchase_charges WHERE purchase_id = ${id}`;
  await tx`DELETE FROM purchase_orders WHERE id = ${id}`;
  await audit(tx, actor, { action: "purchase.delete_draft", entityType: "purchase_order", entityId: id });
}

export async function purchaseOutstanding(tx: Tx, purchaseId: string) {
  const [r] = await tx`SELECT po.total::text AS total, po.payment_type,
      COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0)::text AS paid,
      COALESCE((SELECT sum(r.total_orig) FROM purchase_returns r WHERE r.purchase_id = po.id AND r.status = 'POSTED' AND r.settlement = 'REDUCE_PAYABLE'), 0)::text AS returned
    FROM purchase_orders po WHERE po.id = ${purchaseId}`;
  if (!r) throw notFound();
  const out = r.payment_type === "CREDIT" ? Decimal.max(d(r.total).minus(r.paid).minus(r.returned), 0) : d(0);
  return { total: r.total as string, paid: r.paid as string, returned: r.returned as string, outstanding: out.toString() };
}

export async function getPurchase(tx: Tx, id: string) {
  const [h] = await tx`SELECT po.id, po.draft_ref AS "draftRef", po.doc_no AS "docNo", po.doc_date::text AS "docDate", po.supplier_id AS "supplierId", c.name AS "supplierName", c.phones AS "supplierPhones", c.address AS "supplierAddress",
      po.supplier_invoice_no AS "supplierInvoiceNo", po.payment_type AS "paymentType", po.cash_account_id AS "cashAccountId", po.due_date::text AS "dueDate", po.currency,
      po.exchange_rate_snapshot::text AS "exchangeRate", po.total::text AS total, po.total_base::text AS "totalBase", po.status, po.version, po.notes
    FROM purchase_orders po JOIN contacts c ON c.id = po.supplier_id WHERE po.id = ${id}`;
  if (!h) throw notFound();
  const lines = await tx`SELECT pl.id, pl.profit_class AS "profitClass", pl.line_no AS "lineNo", pl.product_id AS "productId", p.code AS "productCode", p.name AS "productName", pl.uom, pl.qty::text, pl.qty_base::text AS "qtyBase",
      pl.unit_price::text AS "unitPrice", pl.line_total::text AS "lineTotal", pl.line_total_base::text AS "lineTotalBase", pl.location_id AS "locationId"
    FROM purchase_lines pl JOIN products p ON p.id = pl.product_id WHERE pl.purchase_id = ${id} ORDER BY pl.line_no`;
  const charges = await tx`SELECT kind, description, amount::text, capitalize, amount_base::text AS "amountBase" FROM purchase_charges WHERE purchase_id = ${id} ORDER BY line_no`;
  return { ...h, lines, charges, ...(h.status === "DRAFT" ? {} : await purchaseOutstanding(tx, id)) };
}

export async function listPurchases(tx: Tx, status?: string) {
  const rows = await tx`SELECT po.id, po.supplier_id AS "supplierId", po.draft_ref AS "draftRef", po.doc_no AS "docNo", po.doc_date::text AS "docDate", c.name AS "supplierName", po.payment_type AS "paymentType",
      po.currency, po.total::text AS total, po.status, po.due_date::text AS "dueDate",
      CASE WHEN po.status <> 'POSTED' THEN NULL WHEN po.payment_type = 'CASH' THEN '0' ELSE (po.total
        - COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0)
        - COALESCE((SELECT sum(r.total_orig) FROM purchase_returns r WHERE r.purchase_id = po.id AND r.status = 'POSTED' AND r.settlement = 'REDUCE_PAYABLE'), 0))::text END AS outstanding
    FROM purchase_orders po JOIN contacts c ON c.id = po.supplier_id WHERE (${status ?? null}::text IS NULL OR po.status = ${status ?? null})
    ORDER BY po.doc_date DESC, po.created_at DESC LIMIT 300`;
  return rows;
}

/** POST: assigns the final number, creates FIFO layers and the balanced journal entry in ONE transaction. */
export async function postPurchase(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [po] = await tx`SELECT * FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
  if (!po) throw notFound();
  if (po.status !== "DRAFT") throw conflict("NOT_DRAFT", "المستند ليس مسودة");
  const lines = await tx`SELECT * FROM purchase_lines WHERE purchase_id = ${id} ORDER BY line_no`;
  if (lines.length === 0) throw badRequest("NO_LINES");
  const [sup] = await tx`SELECT is_archived FROM contacts WHERE id = ${po.supplier_id}`;
  if (sup!.is_archived) throw conflict("SUPPLIER_ARCHIVED");
  const fx = po.exchange_rate_snapshot as string, cur = po.currency as string;
  const received = stamp(po.doc_date instanceof Date ? po.doc_date.toISOString().slice(0, 10) : String(po.doc_date));
  const docDate = received.slice(0, 10);
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'purchase_order', ${yearOf(docDate)}) AS n`)[0]!.n as string;

  const charges = await tx`SELECT * FROM purchase_charges WHERE purchase_id = ${id} ORDER BY line_no`;
  const lineBase = lines.map((l) => toBase(l.line_total, fx, cur));
  const goodsBase = lineBase.reduce((s, b) => s.plus(b), d(0));
  let capBase = d(0), capOrig = d(0); const expense = new Map<string, { base: Decimal; orig: Decimal }>();
  for (const c of charges) {
    const base = toBase(c.amount, fx, cur);
    await tx`UPDATE purchase_charges SET amount_base = ${base.toString()} WHERE id = ${c.id}`;
    if (c.capitalize) { capBase = capBase.plus(base); capOrig = capOrig.plus(c.amount); }
    else { const acct = c.kind === "TRANSPORT" ? "6100" : "6900"; const e = expense.get(acct) ?? { base: d(0), orig: d(0) }; expense.set(acct, { base: e.base.plus(base), orig: e.orig.plus(c.amount) }); }
  }
  // Capitalised charges are spread over this purchase's layers pro-rata to goods value (fallback: by quantity); the rounding remainder goes to the last line.
  const alloc: Decimal[] = []; let given = d(0);
  const qtySum = lines.reduce((s: Decimal, l) => s.plus(l.qty_base as string), d(0));
  lines.forEach((l, i) => {
    const share = i === lines.length - 1 ? capBase.minus(given)
      : roundMoney(capBase.mul(goodsBase.gt(0) ? lineBase[i]!.div(goodsBase) : d(l.qty_base).div(qtySum)), "IQD");
    alloc.push(share); given = given.plus(share);
  });
  const invByAcct = new Map<string, { base: Decimal; orig: Decimal }>();
  let totalBase = d(0), totalOrig = d(0);
  for (const [i, l] of lines.entries()) {
    const base = lineBase[i]!, landed = alloc[i]!;
    await tx`UPDATE purchase_lines SET line_total_base = ${base.toString()}, landed_cost_base = ${landed.toString()} WHERE id = ${l.id}`;
    await receiveLot(tx, who.companyId, { productId: l.product_id, locationId: l.location_id, originDocType: "purchase_order", originDocId: id, originLineId: l.id,
      receivedAt: received, qtyBase: l.qty_base, totalCostBase: base.plus(landed), unitCostOrig: d(l.line_total).div(l.qty_base).toDecimalPlaces(4), currency: cur, fx, movement: "PURCHASE_IN", profitClass: l.profit_class });
    const acct = await inventoryAccountOf(tx, l.location_id);
    const cur_ = invByAcct.get(acct) ?? { base: d(0), orig: d(0) };
    const origShare = capBase.gt(0) ? capOrig.mul(landed).div(capBase) : d(0);
    invByAcct.set(acct, { base: cur_.base.plus(base).plus(landed), orig: cur_.orig.plus(l.line_total).plus(origShare) });
    totalBase = totalBase.plus(base).plus(landed); totalOrig = totalOrig.plus(l.line_total).plus(origShare);
  }
  for (const e of expense.values()) { totalBase = totalBase.plus(e.base); totalOrig = totalOrig.plus(e.orig); }
  const jl: JLine[] = [...invByAcct].map(([account, v]) => ({ account, debit: v.base, currency: cur, amountOrig: v.orig, fx }));
  for (const [account, v] of expense) jl.push({ account, debit: v.base, currency: cur, amountOrig: v.orig, fx, memo: "تكلفة إضافية على الفاتورة (مصروف)" });
  if (po.payment_type === "CASH") {
    await assertCashAvailable(tx, po.cash_account_id, totalOrig);
    const [ca] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${po.cash_account_id}`;
    jl.push({ account: ca!.code, credit: totalBase, currency: cur, amountOrig: totalOrig, fx });
    await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca!.id}, ${totalOrig.neg().toString()}, ${totalBase.neg().toString()}, 'purchase_order', ${id})`;
  } else jl.push({ account: "2100", credit: totalBase, currency: cur, amountOrig: totalOrig, fx, contactId: po.supplier_id });
  const je = await postJournal(tx, actor, { date: docDate, sourceDocType: "purchase_order", sourceDocId: id, memo: `فاتورة شراء ${docNo}`, lines: jl });
  const [h] = await tx`UPDATE purchase_orders SET status = 'POSTED', doc_no = ${docNo}, total_base = ${totalBase.toString()}, posted_by = ${who.userId}, posted_at = now(),
      journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status, version`;
  await audit(tx, actor, { action: "purchase.post", entityType: "purchase_order", entityId: id, after: { docNo, totalBase: totalBase.toString() } });
  return h!;
}

export const reverseSchema = z.object({ reason: z.string().min(3).max(500) });

export async function reversePurchase(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [po] = await tx`SELECT * FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
  if (!po) throw notFound();
  if (po.status !== "POSTED") throw conflict("NOT_POSTED", "يمكن عكس المستند المرحّل فقط");
  if ((await tx`SELECT 1 FROM purchase_returns WHERE purchase_id = ${id} AND status = 'POSTED'`).length) throw conflict("HAS_RETURNS", "يوجد مرتجع مرحّل على هذه الفاتورة؛ اعكسه أولاً");
  if ((await tx`SELECT 1 FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = ${id} AND sp.status = 'POSTED'`).length) throw conflict("HAS_PAYMENTS", "توجد دفعات مرحّلة؛ اعكسها أولاً");
  const today = new Date().toISOString().slice(0, 10);
  if (!(await retireLots(tx, who.companyId, "purchase_order", id, new Date()))) throw conflict("PURCHASE_LOT_CONSUMED", "جزء من البضاعة بيع أو نُقل؛ اعكس تلك الحركات أولاً");
  await reverseEntry(tx, actor, po.journal_entry_id, today, `عكس فاتورة شراء ${po.doc_no}: ${reason}`);
  if (po.payment_type === "CASH") await reverseCashMovements(tx, "purchase_order", id);
  await tx`UPDATE purchase_orders SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "purchase.reverse", entityType: "purchase_order", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// ======================= purchase returns =======================
export const returnSchema = z.object({
  purchaseId: uuid, docDate: dateStr, settlement: z.enum(["REDUCE_PAYABLE", "CASH_REFUND"]), cashAccountId: uuid.nullish(), reason: z.string().min(3).max(500),
  lines: z.array(z.object({ purchaseLineId: uuid, qtyBase: qtyStr, exceptionalReason: z.string().min(5).max(500).nullish() })).min(1).max(100),
});

export async function createReturn(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof returnSchema>) {
  const [po] = await tx`SELECT status, currency FROM purchase_orders WHERE id = ${i.purchaseId}`;
  if (!po || po.status !== "POSTED") throw conflict("PURCHASE_NOT_POSTED", "المرتجع على فاتورة مرحّلة فقط");
  if (i.settlement === "CASH_REFUND") {
    const [c] = await tx`SELECT currency FROM cash_accounts WHERE id = ${i.cashAccountId ?? null}`;
    if (!c || c.currency !== po.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "حدد صندوقاً بعملة الفاتورة للاسترداد النقدي");
  }
  const ids = i.lines.map((l) => l.purchaseLineId);
  const found = await tx`SELECT id FROM purchase_lines WHERE purchase_id = ${i.purchaseId} AND id IN ${tx(ids)}`;
  if (found.length !== new Set(ids).size) throw badRequest("LINE_NOT_IN_PURCHASE");
  const [h] = await tx`INSERT INTO purchase_returns(company_id, draft_ref, doc_date, purchase_id, settlement, cash_account_id, reason, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.purchaseId}, ${i.settlement}, ${i.settlement === "CASH_REFUND" ? i.cashAccountId! : null}, ${i.reason}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  let n = 0;
  for (const l of i.lines) {
    n += 1;
    await tx`INSERT INTO purchase_return_lines(company_id, return_id, line_no, purchase_line_id, qty_base, exceptional_reason) VALUES (${who.companyId}, ${h!.id}, ${n}, ${l.purchaseLineId}, ${l.qtyBase}, ${l.exceptionalReason ?? null})`;
  }
  await audit(tx, actor, { action: "purchase_return.create_draft", entityType: "purchase_return", entityId: h!.id, after: i });
  return h!;
}

export async function deleteReturnDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM purchase_returns WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM purchase_return_lines WHERE return_id = ${id}`;
  await tx`DELETE FROM purchase_returns WHERE id = ${id}`;
  await audit(tx, actor, { action: "purchase_return.delete_draft", entityType: "purchase_return", entityId: id });
}

export async function listReturns(tx: Tx) {
  return tx`SELECT r.id, r.draft_ref AS "draftRef", r.doc_no AS "docNo", r.doc_date::text AS "docDate", po.doc_no AS "purchaseNo", r.settlement, r.status, r.total_base::text AS "totalBase"
    FROM purchase_returns r JOIN purchase_orders po ON po.id = r.purchase_id ORDER BY r.doc_date DESC, r.created_at DESC LIMIT 200`;
}

/**
 * Supplier return. Stock leaves the ORIGINAL layer (and layers transferred out of it) at that layer's cost.
 * Quantity already sold/consumed can only be returned as a documented exceptional item approved by the owner:
 * the supplier's refund of that part is booked against 5200 because its cost was already expensed through COGS.
 */
export async function postReturn(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [r] = await tx`SELECT * FROM purchase_returns WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound();
  if (r.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const [po] = await tx`SELECT * FROM purchase_orders WHERE id = ${r.purchase_id} FOR UPDATE`;
  if (po!.status !== "POSTED") throw conflict("PURCHASE_NOT_POSTED");
  const lines = await tx`SELECT * FROM purchase_return_lines WHERE return_id = ${id} ORDER BY line_no`;
  const date = r.doc_date instanceof Date ? r.doc_date.toISOString().slice(0, 10) : String(r.doc_date);
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'purchase_return', ${yearOf(date)}) AS n`)[0]!.n as string;
  const fx = po!.exchange_rate_snapshot as string, cur = po!.currency as string;
  const credit: Map<string, Decimal> = new Map(); let costTotal = d(0), shortageTotal = d(0);
  for (const l of lines) {
    const [pl] = await tx`SELECT * FROM purchase_lines WHERE id = ${l.purchase_line_id}`;
    const already = (await tx`SELECT COALESCE(sum(rl.qty_base + rl.shortage_qty_base), 0)::text AS q FROM purchase_return_lines rl JOIN purchase_returns rr ON rr.id = rl.return_id
        WHERE rl.purchase_line_id = ${pl!.id} AND rr.status = 'POSTED'`)[0]!.q as string;
    const want = d(l.qty_base);
    if (d(already).plus(want).gt(pl!.qty_base)) throw conflict("RETURN_EXCEEDS_PURCHASED", `الكمية المرتجعة الكلية تتجاوز المشتراة (${pl!.qty_base})`);
    const fam = await lotFamily(tx, po!.id, pl!.id);
    const parts = await consumeFromLots(tx, who.companyId, fam, want, { type: "PURCHASE_RETURN_OUT", docType: "purchase_return", docId: id, docLineId: l.id, at: new Date(`${date}T12:00:00Z`) });
    const taken = parts.reduce((s, p) => s.plus(p.qty), d(0)), cost = parts.reduce((s, p) => s.plus(p.cost), d(0));
    const shortage = want.minus(taken);
    let shortageValue = d(0);
    if (shortage.gt(0)) {
      if (!l.exceptional_reason) throw conflict("LAYER_ALREADY_SOLD", `المتاح للإرجاع من هذه الدفعة ${taken} فقط؛ الباقي بيع أو استُهلك`);
      if (!who.isOwner) throw forbidden("EXCEPTIONAL_RETURN_OWNER_ONLY");
      shortageValue = roundMoney(d(pl!.line_total_base).plus(pl!.landed_cost_base).mul(shortage).div(pl!.qty_base), "IQD");
    }
    await tx`UPDATE purchase_return_lines SET shortage_qty_base = ${shortage.toString()}, cost_base = ${cost.toString()}, shortage_value_base = ${shortageValue.toString()} WHERE id = ${l.id}`;
    for (const p of parts) { const a = await inventoryAccountOf(tx, p.lot.location_id); credit.set(a, (credit.get(a) ?? d(0)).plus(p.cost)); }
    if (shortageValue.gt(0)) credit.set("5200", (credit.get("5200") ?? d(0)).plus(shortageValue));
    costTotal = costTotal.plus(cost); shortageTotal = shortageTotal.plus(shortageValue);
  }
  const totalBase = costTotal.plus(shortageTotal), totalOrig = cur === "IQD" ? totalBase : roundMoney(totalBase.div(fx), cur);
  const jl: JLine[] = [];
  if (r.settlement === "REDUCE_PAYABLE") jl.push({ account: "2100", debit: totalBase, currency: cur, amountOrig: totalOrig, fx, contactId: po!.supplier_id });
  else {
    const [ca] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${r.cash_account_id}`;
    jl.push({ account: ca!.code, debit: totalBase, currency: cur, amountOrig: totalOrig, fx });
    await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca!.id}, ${totalOrig.toString()}, ${totalBase.toString()}, 'purchase_return', ${id})`;
  }
  for (const [account, v] of credit) jl.push({ account, credit: v, currency: cur, amountOrig: v, fx });
  const je = await postJournal(tx, actor, { date, sourceDocType: "purchase_return", sourceDocId: id, memo: `مرتجع مشتريات ${docNo}`, lines: jl });
  const [h] = await tx`UPDATE purchase_returns SET status = 'POSTED', doc_no = ${docNo}, total_base = ${totalBase.toString()}, total_orig = ${totalOrig.toString()}, posted_by = ${who.userId}, posted_at = now(),
      journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "purchase_return.post", entityType: "purchase_return", entityId: id, after: { docNo, totalBase: totalBase.toString(), shortage: shortageTotal.toString() } });
  return { ...h!, totalBase: totalBase.toString() };
}
