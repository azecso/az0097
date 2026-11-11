import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, toBase } from "../money";
import { postJournal, type JLine } from "../ledger";
import { inventoryAccountOf, receiveLot } from "../inventory";
import { currencyCode, dateStr, moneyStr, qtyStr, rateStr, uuid, yearOf } from "./common";

export const openingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CAPITAL"), asOf: dateStr, amount: moneyStr, note: z.string().max(200).nullish() }),
  z.object({ kind: z.literal("RETAINED_EARNINGS"), asOf: dateStr, amount: moneyStr, note: z.string().min(5, "يجب توثيق الأرباح المحتجزة الافتتاحية").max(300) }),
  z.object({ kind: z.literal("CASH"), asOf: dateStr, cashAccountId: uuid, amount: moneyStr, fxRate: rateStr.nullish(), note: z.string().max(200).nullish() }),   // currency comes from the cash account; amount is in that currency
  z.object({ kind: z.literal("INVENTORY_LAYER"), asOf: dateStr, productId: uuid, locationId: uuid, qtyBase: qtyStr, amount: moneyStr, receivedAt: dateStr, note: z.string().max(200).nullish() }),   // amount = TOTAL layer cost (IQD)
  z.object({ kind: z.enum(["CUSTOMER", "SUPPLIER"]), asOf: dateStr, contactId: uuid, currency: currencyCode, fxRate: rateStr.nullish(), amount: moneyStr, dueDate: dateStr.nullish(), note: z.string().max(200).nullish() }),
]);

export async function addOpening(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof openingSchema>) {
  if ((await tx`SELECT 1 FROM opening_balances WHERE status = 'POSTED' LIMIT 1`).length) throw conflict("OPENING_ALREADY_POSTED", "الأرصدة الافتتاحية اعتُمدت مسبقاً");
  const x = i as Record<string, any>;
  if (d(x.amount).lte(0)) throw badRequest("INVALID_AMOUNT");
  if (i.kind === "CUSTOMER" || i.kind === "SUPPLIER") {
    const [c] = await tx`SELECT kind FROM contacts WHERE id = ${i.contactId}`;
    if (!c || (i.kind === "CUSTOMER" ? c.kind === "SUPPLIER" : c.kind === "CUSTOMER")) throw badRequest("WRONG_CONTACT_KIND");
    if (i.currency !== "IQD" && !i.fxRate) throw badRequest("FX_RATE_REQUIRED", "أدخل سعر الصرف للرصيد بالدولار");
  }
  if (i.kind === "CASH") {                                      // the cash account decides the currency; a foreign-currency account needs its opening rate
    const [c] = await tx`SELECT currency FROM cash_accounts WHERE id = ${i.cashAccountId} AND is_active`; if (!c) throw badRequest("BAD_CASH_ACCOUNT");
    x.currency = c.currency as string;
    if (x.currency === "IQD") x.fxRate = "1";
    else { if (!i.fxRate) throw badRequest("FX_RATE_REQUIRED", "أدخل سعر الصرف لرصيد الصندوق بالدولار"); const n = d(i.fxRate); if (n.lt(1) || n.gt(100000)) throw badRequest("RATE_OUT_OF_RANGE"); }
  }
  const [r] = await tx`INSERT INTO opening_balances(company_id, as_of, kind, cash_account_id, contact_id, product_id, location_id, currency, fx_rate, amount, qty_base, received_at, note, created_by)
    VALUES (${who.companyId}, ${i.asOf}, ${i.kind}, ${x.cashAccountId ?? null}, ${x.contactId ?? null}, ${x.productId ?? null}, ${x.locationId ?? null}, ${x.currency ?? "IQD"}, ${x.fxRate ?? 1}, ${x.amount}, ${x.qtyBase ?? null}, ${x.receivedAt ?? null}, ${x.note ?? null}, ${who.userId}) RETURNING id`;
  await audit(tx, actor, { action: "opening.add", entityType: "opening_balance", entityId: r!.id, after: i });
  return r!;
}
export async function deleteOpening(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx`DELETE FROM opening_balances WHERE id = ${id} AND status = 'DRAFT' RETURNING id`;
  if (!r) throw notFound();
  await audit(tx, actor, { action: "opening.delete", entityType: "opening_balance", entityId: id });
  return { id };
}
export const listOpening = (tx: Tx) => tx`SELECT o.id, o.as_of::text AS "asOf", o.kind, o.currency, o.amount::text AS amount, o.qty_base::text AS qty, o.note, o.status, c.name AS contact, ca.name AS "cashAccount", p.code AS product
  FROM opening_balances o LEFT JOIN contacts c ON c.id = o.contact_id LEFT JOIN cash_accounts ca ON ca.id = o.cash_account_id LEFT JOIN products p ON p.id = o.product_id ORDER BY o.kind, o.created_at`;

/** The opening equation, computed for the screen and enforced at posting. */
export async function openingEquation(tx: Tx) {
  const rows = await tx`SELECT * FROM opening_balances WHERE status = 'DRAFT'`;
  let cash = d(0), inventory = d(0), customers = d(0), suppliers = d(0), capital = d(0), retained = d(0);
  for (const r of rows) {
    const base = toBase(r.amount, r.fx_rate, r.currency);
    if (r.kind === "CASH") cash = cash.plus(base);
    else if (r.kind === "INVENTORY_LAYER") inventory = inventory.plus(base);
    else if (r.kind === "CUSTOMER") customers = customers.plus(base);
    else if (r.kind === "SUPPLIER") suppliers = suppliers.plus(base);
    else if (r.kind === "CAPITAL") capital = capital.plus(base);
    else retained = retained.plus(base);
  }
  const assets = cash.plus(inventory).plus(customers), equity = capital.plus(retained);
  return { rows: rows.length, cash: cash.toString(), inventory: inventory.toString(), customers: customers.toString(), suppliers: suppliers.toString(), capital: capital.toString(), retainedEarnings: retained.toString(),
    assets: assets.toString(), liabilities: suppliers.toString(), equity: equity.toString(), difference: assets.minus(suppliers).minus(equity).toString() };
}

/** Posts ONE balanced opening entry. Any difference is REPORTED and blocks posting — no unexplained plug entry is ever invented. */
export async function postOpening(tx: Tx, who: Principal, actor: Actor) {
  if ((await tx`SELECT 1 FROM opening_balances WHERE status = 'POSTED' LIMIT 1`).length) throw conflict("OPENING_ALREADY_POSTED");
  const eq = await openingEquation(tx);
  if (eq.rows === 0) throw badRequest("NOTHING_TO_POST");
  if (!d(eq.difference).isZero()) throw conflict("OPENING_IMBALANCE", `الميزانية الافتتاحية غير متوازنة: أصول ${eq.assets} − التزامات ${eq.liabilities} − حقوق ملكية ${eq.equity} = فرق ${eq.difference}`);
  const rows = await tx`SELECT * FROM opening_balances WHERE status = 'DRAFT' ORDER BY kind, created_at`;
  const asOf = String(rows[0]!.as_of instanceof Date ? rows[0]!.as_of.toISOString().slice(0, 10) : rows[0]!.as_of);
  const batch = crypto.randomUUID(); const jl: JLine[] = []; const owner = (await tx`SELECT id FROM partners WHERE kind = 'OWNER'`)[0]!.id as string;
  const inv = new Map<string, Decimal>();
  for (const r of rows) {
    const date = r.as_of instanceof Date ? r.as_of.toISOString().slice(0, 10) : String(r.as_of), base = toBase(r.amount, r.fx_rate, r.currency);
    if (date !== asOf) throw badRequest("MIXED_DATES", "كل الأرصدة الافتتاحية يجب أن تحمل نفس التاريخ");
    if (r.kind === "CASH") {
      const [c] = await tx`SELECT ca.id, ca.currency, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${r.cash_account_id}`;
      if (c!.currency !== r.currency || (c!.currency !== "IQD" && d(r.fx_rate).lte(1))) throw badRequest("OPENING_CASH_CURRENCY", "رصيد افتتاحي لصندوق بعملة أجنبية بلا سعر صرف صالح؛ احذفه وأعد إدخاله");
      jl.push({ account: c!.code, debit: base, currency: c!.currency, amountOrig: r.amount, fx: r.fx_rate });
      await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${c!.id}, ${r.amount}, ${base.toString()}, 'opening', ${batch})`;
    } else if (r.kind === "INVENTORY_LAYER") {
      const received = `${r.received_at instanceof Date ? r.received_at.toISOString().slice(0, 10) : r.received_at}T00:00:00Z`;
      await receiveLot(tx, who.companyId, { productId: r.product_id, locationId: r.location_id, originDocType: "opening", originDocId: batch, receivedAt: received, qtyBase: r.qty_base, totalCostBase: base,
        unitCostOrig: base.div(r.qty_base).toDecimalPlaces(4), currency: "IQD", fx: "1", movement: "OPENING" });
      const a = await inventoryAccountOf(tx, r.location_id); inv.set(a, (inv.get(a) ?? d(0)).plus(base));
    } else if (r.kind === "CUSTOMER") {
      const [si] = await tx`INSERT INTO sales_invoices(company_id, draft_ref, doc_no, doc_date, customer_id, sale_type, due_date, delivery_mode, currency, exchange_rate_snapshot, gross, discount, net, gross_base, net_base, notes, status, is_opening, created_by, posted_by, posted_at)
        VALUES (${who.companyId}, ${"OPEN-" + crypto.randomUUID().slice(0, 8)}, ${(await tx`SELECT next_document_number(${who.companyId}, 'sales_invoice', ${yearOf(asOf)}) AS n`)[0]!.n}, ${asOf}, ${r.contact_id}, 'CREDIT', ${asOf}, 'SEPARATE', ${r.currency}, ${r.fx_rate},
                ${r.amount}, 0, ${r.amount}, ${base.toString()}, ${base.toString()}, 'رصيد افتتاحي', 'POSTED', true, ${who.userId}, ${who.userId}, now()) RETURNING id`;
      jl.push({ account: "1200", debit: base, currency: r.currency, amountOrig: r.amount, fx: r.fx_rate, contactId: r.contact_id, memo: `رصيد افتتاحي عميل (${si!.id})` });
    } else if (r.kind === "SUPPLIER") {
      await tx`INSERT INTO purchase_orders(company_id, draft_ref, doc_no, doc_date, supplier_id, payment_type, currency, exchange_rate_snapshot, total, total_base, notes, status, is_opening, created_by, posted_by, posted_at)
        VALUES (${who.companyId}, ${"OPEN-" + crypto.randomUUID().slice(0, 8)}, ${(await tx`SELECT next_document_number(${who.companyId}, 'purchase_order', ${yearOf(asOf)}) AS n`)[0]!.n}, ${asOf}, ${r.contact_id}, 'CREDIT', ${r.currency}, ${r.fx_rate},
                ${r.amount}, ${base.toString()}, 'رصيد افتتاحي', 'POSTED', true, ${who.userId}, ${who.userId}, now())`;
      jl.push({ account: "2100", credit: base, currency: r.currency, amountOrig: r.amount, fx: r.fx_rate, contactId: r.contact_id, memo: "رصيد افتتاحي مورد" });
    } else if (r.kind === "CAPITAL") jl.push({ account: "3100", credit: base, partnerId: owner });
    else jl.push({ account: "3300", credit: base, memo: r.note });
  }
  for (const [a, v] of inv) jl.push({ account: a, debit: v });
  const je = await postJournal(tx, actor, { date: asOf, sourceDocType: "opening", sourceDocId: batch, memo: "الأرصدة الافتتاحية", lines: jl });
  await tx`UPDATE opening_balances SET status = 'POSTED' WHERE status = 'DRAFT'`;
  await audit(tx, actor, { action: "opening.post", entityType: "opening_balance", after: { ...eq, journalEntry: je } });
  return { journalEntryId: je, ...eq };
}
