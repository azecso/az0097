// FIFO inventory engine. Layers are (product, location, receipt). Outflows consume the OLDEST layers first under
// row locks (SELECT … FOR UPDATE), record exactly which layer/cost they used, and can be reversed precisely.
import Decimal from "decimal.js";
import type { Tx } from "./db";
import { d, roundMoney } from "./money";
import { conflict } from "./errors";

export type MovementType = "PURCHASE_IN" | "SALE_OUT" | "TRANSFER_OUT" | "TRANSFER_IN" | "SALE_RETURN_IN" | "PURCHASE_RETURN_OUT" | "COUNT_ADJ" | "OPENING" | "REVERSAL";

export interface Lot {
  id: string; product_id: string; location_id: string; received_at: Date; qty_remaining: string; qty_received: string;
  cost_remaining_base: string; total_cost_base: string; unit_cost_orig: string; currency: string; fx_rate_snapshot: string; source_lot_id: string | null;
}
export interface Part { lot: Lot; qty: Decimal; cost: Decimal }

async function movement(tx: Tx, companyId: string, m: { productId: string; locationId: string; lotId: string; type: MovementType; qty: Decimal; cost: Decimal; docType: string; docId: string; at: Date | string }) {
  await tx`INSERT INTO stock_movements(company_id, product_id, location_id, lot_id, movement_type, qty_base, cost_base, doc_type, doc_id, moved_at)
    VALUES (${companyId}, ${m.productId}, ${m.locationId}, ${m.lotId}, ${m.type}, ${m.qty.toString()}, ${m.cost.toString()}, ${m.docType}, ${m.docId}, ${m.at as string})`;
}

export async function receiveLot(tx: Tx, companyId: string, a: {
  productId: string; locationId: string; originDocType: string; originDocId: string; originLineId?: string | null; receivedAt: Date | string;
  qtyBase: Decimal.Value; totalCostBase: Decimal.Value; unitCostOrig: Decimal.Value; currency: string; fx: Decimal.Value;
  sourceLotId?: string | null; movement: MovementType; profitClass?: "PARTNERSHIP" | "USED";
}): Promise<string> {
  const qty = d(a.qtyBase), total = roundMoney(a.totalCostBase, "IQD");
  const unit = total.div(qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const [lot] = await tx`INSERT INTO stock_lots(company_id, product_id, location_id, source_lot_id, origin_doc_type, origin_doc_id, origin_line_id, received_at,
      qty_received, qty_remaining, total_cost_base, cost_remaining_base, unit_cost_base, unit_cost_orig, currency, fx_rate_snapshot, profit_class)
    VALUES (${companyId}, ${a.productId}, ${a.locationId}, ${a.sourceLotId ?? null}, ${a.originDocType}, ${a.originDocId}, ${a.originLineId ?? null}, ${a.receivedAt as string},
      ${qty.toString()}, ${qty.toString()}, ${total.toString()}, ${total.toString()}, ${unit.toString()}, ${d(a.unitCostOrig).toString()}, ${a.currency}, ${d(a.fx).toString()},
      COALESCE(${a.profitClass ?? null}::text, (SELECT profit_class FROM stock_lots WHERE id = ${a.sourceLotId ?? null}), 'PARTNERSHIP'))
    RETURNING id`;
  await movement(tx, companyId, { productId: a.productId, locationId: a.locationId, lotId: lot!.id, type: a.movement, qty, cost: total, docType: a.originDocType, docId: a.originDocId, at: a.receivedAt });
  return lot!.id as string;
}

/** Cost of taking `take` out of a lot: the whole remainder is exact; a partial take is proportional, rounded to the dinar. */
function costOfTake(lot: Lot, take: Decimal): Decimal {
  const rem = d(lot.qty_remaining), costRem = d(lot.cost_remaining_base);
  if (take.eq(rem)) return costRem;
  const c = roundMoney(costRem.mul(take).div(rem), "IQD");
  return Decimal.min(c, costRem);
}

async function takeFromLot(tx: Tx, companyId: string, lot: Lot, take: Decimal, o: { type: MovementType; docType: string; docId: string; docLineId: string; at: Date | string }): Promise<Part> {
  const cost = costOfTake(lot, take);
  await tx`UPDATE stock_lots SET qty_remaining = qty_remaining - ${take.toString()}, cost_remaining_base = cost_remaining_base - ${cost.toString()} WHERE id = ${lot.id}`;
  await tx`INSERT INTO stock_lot_consumptions(company_id, lot_id, doc_type, doc_id, doc_line_id, qty, cost_base) VALUES (${companyId}, ${lot.id}, ${o.docType}, ${o.docId}, ${o.docLineId}, ${take.toString()}, ${cost.toString()})`;
  await movement(tx, companyId, { productId: lot.product_id, locationId: lot.location_id, lotId: lot.id, type: o.type, qty: take.neg(), cost: cost.neg(), docType: o.docType, docId: o.docId, at: o.at });
  return { lot, qty: take, cost };
}

const LOT_COLS = (tx: Tx) => tx`id, product_id, location_id, received_at, qty_remaining::text, qty_received::text, cost_remaining_base::text, total_cost_base::text, unit_cost_orig::text, currency, fx_rate_snapshot::text, source_lot_id`;

/** FIFO outflow of `qtyBase` of a product from a location. Throws 409 INSUFFICIENT_STOCK (nothing is written) if short. */
export async function consumeFifo(tx: Tx, companyId: string, a: {
  productId: string; locationId: string; qtyBase: Decimal.Value; type: MovementType; docType: string; docId: string; docLineId: string; at: Date | string;
  /** Document date (YYYY-MM-DD): only layers received on or before this day may be consumed — an outflow never takes goods that had not arrived yet. */
  onOrBefore?: string;
  /** A sale draws only from layers of its own class (PARTNERSHIP / USED). Transfers and counts pass nothing: any class, and the layer keeps its class. */
  profitClass?: "PARTNERSHIP" | "USED";
}): Promise<{ cost: Decimal; parts: Part[] }> {
  const by = a.onOrBefore ?? null;
  const lots = (await tx`SELECT ${LOT_COLS(tx)} FROM stock_lots WHERE product_id = ${a.productId} AND location_id = ${a.locationId} AND qty_remaining > 0
                         AND (${by}::date IS NULL OR received_at < (${by}::date + 1)) AND (${a.profitClass ?? null}::text IS NULL OR profit_class = ${a.profitClass ?? null}) ORDER BY received_at, seq FOR UPDATE`) as unknown as Lot[];
  let need = d(a.qtyBase); const parts: Part[] = [];
  const available = lots.reduce((s, l) => s.plus(l.qty_remaining), d(0));
  if (available.lt(need)) throw conflict("INSUFFICIENT_STOCK", `المتاح${by ? ` حتى ${by}` : ""}${a.profitClass === "USED" ? " (مستعمل)" : ""}: ${available} أقل من المطلوب ${need}`);
  for (const lot of lots) {
    if (need.lte(0)) break;
    const take = Decimal.min(need, d(lot.qty_remaining));
    parts.push(await takeFromLot(tx, companyId, lot, take, a));
    need = need.minus(take);
  }
  return { cost: parts.reduce((s, p) => s.plus(p.cost), d(0)), parts };
}

/** Consume from an explicit ordered set of lots (supplier returns: the original layer and its transfer descendants). */
export async function consumeFromLots(tx: Tx, companyId: string, lotIds: string[], qtyBase: Decimal.Value, o: { type: MovementType; docType: string; docId: string; docLineId: string; at: Date | string }): Promise<Part[]> {
  if (lotIds.length === 0) return [];
  const lots = (await tx`SELECT ${LOT_COLS(tx)} FROM stock_lots WHERE id IN ${tx(lotIds)} AND qty_remaining > 0 ORDER BY seq FOR UPDATE`) as unknown as Lot[];
  let need = d(qtyBase); const parts: Part[] = [];
  for (const lot of lots) {
    if (need.lte(0)) break;
    const take = Decimal.min(need, d(lot.qty_remaining));
    parts.push(await takeFromLot(tx, companyId, lot, take, o));
    need = need.minus(take);
  }
  return parts;
}

/** The origin layer(s) of a purchase line plus every layer derived from them through transfers (with remaining stock). */
export async function lotFamily(tx: Tx, originDocId: string, originLineId: string): Promise<string[]> {
  const rows = await tx`WITH RECURSIVE fam AS (
      SELECT id, seq FROM stock_lots WHERE origin_doc_type = 'purchase_order' AND origin_doc_id = ${originDocId} AND origin_line_id = ${originLineId}
      UNION SELECT l.id, l.seq FROM stock_lots l JOIN fam f ON l.source_lot_id = f.id)
    SELECT id FROM fam f JOIN stock_lots USING (id) WHERE qty_remaining > 0 ORDER BY f.seq`;
  return rows.map((r) => r.id as string);
}

/** Puts back exactly what a document consumed (same layers, same cost). Used when reversing outflow documents. */
export async function restoreConsumptions(tx: Tx, companyId: string, docType: string, docId: string, at: Date | string) {
  const cs = await tx`SELECT c.lot_id, c.qty::text, c.cost_base::text, l.product_id, l.location_id FROM stock_lot_consumptions c JOIN stock_lots l ON l.id = c.lot_id
                      WHERE c.doc_type = ${docType} AND c.doc_id = ${docId} FOR UPDATE OF l`;
  for (const c of cs) {
    await tx`UPDATE stock_lots SET qty_remaining = qty_remaining + ${c.qty}, cost_remaining_base = cost_remaining_base + ${c.cost_base} WHERE id = ${c.lot_id}`;
    await movement(tx, companyId, { productId: c.product_id, locationId: c.location_id, lotId: c.lot_id, type: "REVERSAL", qty: d(c.qty), cost: d(c.cost_base), docType, docId, at });
  }
}

/** Removes layers created by a document, only if completely untouched. Returns false if any was consumed. */
export async function retireLots(tx: Tx, companyId: string, docType: string, docId: string, at: Date | string): Promise<boolean> {
  const lots = await tx`SELECT id, product_id, location_id, qty_received::text, qty_remaining::text, total_cost_base::text, cost_remaining_base::text
                        FROM stock_lots WHERE origin_doc_type = ${docType} AND origin_doc_id = ${docId} FOR UPDATE`;
  if (lots.some((l) => !d(l.qty_remaining).eq(l.qty_received))) return false;
  for (const l of lots) {
    await tx`UPDATE stock_lots SET qty_remaining = 0, cost_remaining_base = 0 WHERE id = ${l.id}`;
    await movement(tx, companyId, { productId: l.product_id, locationId: l.location_id, lotId: l.id, type: "REVERSAL", qty: d(l.qty_received).neg(), cost: d(l.total_cost_base).neg(), docType, docId, at });
  }
  return true;
}

/** Inventory ledger account for a location (1300 main / 1310 partner custody). */
export async function inventoryAccountOf(tx: Tx, locationId: string): Promise<string> {
  const [r] = await tx`SELECT w.kind FROM stock_locations sl JOIN warehouses w ON w.id = sl.warehouse_id WHERE sl.id = ${locationId}`;
  if (!r) throw conflict("LOCATION_NOT_FOUND");
  return r.kind === "MAIN" ? "1300" : "1310";
}

// ---------------------------------------------------------------------------------------------------------------
// Sales-return restock: stock goes back into the EXACT layers the delivery consumed, at their original cost.
// stock_lot_returns remembers how much of each (layer, delivery line) was already put back, only counting POSTED returns.
// ---------------------------------------------------------------------------------------------------------------
export async function restoreForReturn(tx: Tx, companyId: string, a: { salesLineId: string; qtyBase: Decimal.Value; returnId: string; at: Date | string }): Promise<{ cost: Decimal; byLocation: Map<string, Decimal> }> {
  const cons = await tx`
    SELECT c.lot_id, c.doc_line_id, c.qty::text AS qty, c.cost_base::text AS cost, l.product_id, l.location_id,
           COALESCE((SELECT sum(r.qty) FROM stock_lot_returns r JOIN sales_returns sr ON sr.id = r.return_id WHERE r.lot_id = c.lot_id AND r.delivery_line_id = c.doc_line_id AND sr.status = 'POSTED'), 0)::text AS rq,
           COALESCE((SELECT sum(r.cost_base) FROM stock_lot_returns r JOIN sales_returns sr ON sr.id = r.return_id WHERE r.lot_id = c.lot_id AND r.delivery_line_id = c.doc_line_id AND sr.status = 'POSTED'), 0)::text AS rc
    FROM stock_lot_consumptions c JOIN stock_lots l ON l.id = c.lot_id
    WHERE c.doc_type = 'delivery_note' AND c.doc_line_id IN (SELECT dl.id FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = ${a.salesLineId} AND dn.status = 'POSTED')
    ORDER BY c.created_at DESC, c.id DESC FOR UPDATE OF l`;
  let need = d(a.qtyBase), total = d(0); const byLocation = new Map<string, Decimal>();
  for (const c of cons) {
    if (need.lte(0)) break;
    const avail = d(c.qty).minus(c.rq);
    if (avail.lte(0)) continue;
    const take = Decimal.min(need, avail);
    const cost = take.eq(avail) ? d(c.cost).minus(c.rc) : Decimal.min(roundMoney(d(c.cost).mul(take).div(c.qty), "IQD"), d(c.cost).minus(c.rc));
    await tx`UPDATE stock_lots SET qty_remaining = qty_remaining + ${take.toString()}, cost_remaining_base = cost_remaining_base + ${cost.toString()} WHERE id = ${c.lot_id}`;
    await tx`INSERT INTO stock_lot_returns(company_id, lot_id, delivery_line_id, return_id, qty, cost_base) VALUES (${companyId}, ${c.lot_id}, ${c.doc_line_id}, ${a.returnId}, ${take.toString()}, ${cost.toString()})`;
    await movement(tx, companyId, { productId: c.product_id, locationId: c.location_id, lotId: c.lot_id, type: "SALE_RETURN_IN", qty: take, cost, docType: "sales_return", docId: a.returnId, at: a.at });
    total = total.plus(cost); byLocation.set(c.location_id, (byLocation.get(c.location_id) ?? d(0)).plus(cost)); need = need.minus(take);
  }
  if (need.gt(0)) throw conflict("RETURN_EXCEEDS_DELIVERED", "الكمية المرتجعة تتجاوز ما سُلّم");
  return { cost: total, byLocation };
}

/** Takes a return's restocked quantities back out (only if still on hand), for reversing a sales return. */
export async function undoReturnRestock(tx: Tx, companyId: string, returnId: string, at: Date | string) {
  const rs = await tx`SELECT r.lot_id, r.qty::text AS qty, r.cost_base::text AS cost, l.product_id, l.location_id, l.qty_remaining::text AS rem
                      FROM stock_lot_returns r JOIN stock_lots l ON l.id = r.lot_id WHERE r.return_id = ${returnId} FOR UPDATE OF l`;
  for (const r of rs) if (d(r.rem).lt(r.qty)) throw conflict("RETURNED_STOCK_ALREADY_MOVED", "البضاعة المرتجعة بيعت أو نُقلت لاحقاً؛ اعكس تلك الحركات أولاً");
  for (const r of rs) {
    await tx`UPDATE stock_lots SET qty_remaining = qty_remaining - ${r.qty}, cost_remaining_base = cost_remaining_base - ${r.cost} WHERE id = ${r.lot_id}`;
    await movement(tx, companyId, { productId: r.product_id, locationId: r.location_id, lotId: r.lot_id, type: "REVERSAL", qty: d(r.qty).neg(), cost: d(r.cost).neg(), docType: "sales_return", docId: returnId, at });
  }
}
