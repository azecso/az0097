import type { Tx } from "../db";
import Decimal from "decimal.js";
import { d } from "../money";
import { z } from "zod";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { conflict, badRequest, forbidden } from "../errors";

/** Cash account balance in the ACCOUNT'S currency, from the general ledger (single source of truth). */
export async function cashBalance(tx: Tx, cashAccountId: string) {
  const [r] = await tx`SELECT COALESCE(sum(CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END), 0)::text AS b
    FROM journal_lines jl JOIN cash_accounts ca ON ca.account_id = jl.account_id WHERE ca.id = ${cashAccountId}`;
  return d(r!.b);
}

/** Refuses an outflow that would make the cash account negative. Locks the account row so two simultaneous outflows cannot both pass. */
export async function assertCashAvailable(tx: Tx, cashAccountId: string, amount: string | number | { toString(): string }) {
  const [ca] = await tx`SELECT id, name FROM cash_accounts WHERE id = ${cashAccountId} FOR UPDATE`;
  if (!ca) throw badRequest("BAD_CASH_ACCOUNT");
  const bal = await cashBalance(tx, cashAccountId);
  if (bal.lt(amount.toString())) throw conflict("INSUFFICIENT_CASH", `رصيد «${ca.name}» (${bal}) لا يكفي لصرف ${amount}`);
}

/**
 * Cash that may be distributed as profit (policy §6), PER CURRENCY: the cash accounts that count as available cash, minus what is already owed in that
 * currency — accrued payroll/expenses (2200/2210), partner payables (2300), customer credits that may be refunded (2400), supplier invoices due within the horizon.
 * Profit is paid in dinars: `available` = dinar surplus minus any shortfall in another currency (that shortfall would have to be bought with dinars).
 * Partner custody and other non-counting accounts are restricted money and are never included.
 */
export async function distributableLiquidity(tx: Tx, horizonDays = 30) {
  const cashRows = await tx`SELECT ca.currency AS cur, COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN cash_accounts ca ON ca.account_id = jl.account_id
    WHERE ca.counts_toward_available_cash GROUP BY ca.currency`;
  const liabRows = await tx`SELECT COALESCE(jl.currency, 'IQD') AS cur, a.code, COALESCE(sum(jl.credit_base - jl.debit_base), 0)::text AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE a.code IN ('2200','2210','2300','2400') GROUP BY COALESCE(jl.currency, 'IQD'), a.code`;
  const supRows = await tx`SELECT po.currency AS cur, COALESCE(sum(po.total_base - COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0) * po.exchange_rate_snapshot
                                        - COALESCE((SELECT sum(r.total_base) FROM purchase_returns r WHERE r.purchase_id = po.id AND r.status = 'POSTED' AND r.settlement = 'REDUCE_PAYABLE'), 0)), 0)::text AS v
      FROM purchase_orders po WHERE po.status = 'POSTED' AND po.payment_type = 'CREDIT' AND (po.due_date IS NULL OR po.due_date <= CURRENT_DATE + ${horizonDays}::int) GROUP BY po.currency`;
  const cur = new Map<string, { cash: Decimal; accrued: Decimal; customerCredits: Decimal; suppliers: Decimal }>();
  const row = (c: string) => { if (!cur.has(c)) cur.set(c, { cash: d(0), accrued: d(0), customerCredits: d(0), suppliers: d(0) }); return cur.get(c)!; };
  for (const r of cashRows) row(r.cur as string).cash = d(r.v as string);
  for (const r of liabRows) { const x = row(r.cur as string); if (r.code === "2400") x.customerCredits = x.customerCredits.plus(r.v as string); else x.accrued = x.accrued.plus(r.v as string); }
  for (const r of supRows) { const x = row(r.cur as string); x.suppliers = x.suppliers.plus(Decimal0(r.v as string)); }
  row("IQD");
  let available = d(0); const byCurrency: Record<string, { cash: string; committed: string; free: string }> = {};
  let accrued = d(0), suppliers = d(0), credits = d(0), cashAll = d(0), committedAll = d(0);
  for (const [c, x] of cur) {
    const committed = Decimal0(x.accrued.toString()).plus(Decimal0(x.customerCredits.toString())).plus(x.suppliers), free = x.cash.minus(committed);
    byCurrency[c] = { cash: x.cash.toString(), committed: committed.toString(), free: free.toString() };
    available = c === "IQD" ? available.plus(free) : available.plus(free.lt(0) ? free : 0);          // a foreign-currency surplus never pays a dinar profit; a shortfall reduces it
    accrued = accrued.plus(x.accrued); suppliers = suppliers.plus(x.suppliers); credits = credits.plus(x.customerCredits); committedAll = committedAll.plus(committed);
    if (c === "IQD") cashAll = x.cash;
  }
  return { cash: cashAll, committed: committedAll, available, accruedLiabilities: accrued.toString(), suppliersDue: suppliers.toString(), customerCredits: credits.toString(), byCurrency };
}
const Decimal0 = (v: string | { toString(): string }) => { const x = d(v.toString()); return x.isNegative() ? d(0) : x; };

/** New cash account / bank / custody in a currency (owner only). It gets its own ledger account (next free code in 1130–1199) so balances never mix. */
export const cashAccountSchema = z.object({ name: z.string().min(2).max(80), currency: z.enum(["IQD", "USD"]), kind: z.enum(["MAIN_CASH", "BANK", "PARTNER_CUSTODY"]) });
export async function createCashAccount(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof cashAccountSchema>) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const used = new Set((await tx`SELECT code FROM accounts WHERE code ~ '^11[3-9][0-9]$'`).map((r) => r.code as string));
  let code = ""; for (let n = 1130; n <= 1199; n++) if (!used.has(String(n)) && n !== 1150 && n !== 1151) { code = String(n); break; }
  if (!code) throw conflict("NO_FREE_ACCOUNT_CODE");
  const [a] = await tx`INSERT INTO accounts(company_id, code, name, type, normal_side, is_system) VALUES (${who.companyId}, ${code}, ${i.name}, 'ASSET', 'DEBIT', false) RETURNING id`;
  const [c] = await tx`INSERT INTO cash_accounts(company_id, account_id, name, currency, kind, counts_toward_available_cash) VALUES (${who.companyId}, ${a!.id}, ${i.name}, ${i.currency}, ${i.kind}, ${i.kind !== "PARTNER_CUSTODY"}) RETURNING id`;
  await audit(tx, actor, { action: "cash_account.create", entityType: "cash_account", entityId: c!.id, after: { ...i, code } });
  return { id: c!.id as string, code };
}
