import type { Tx } from "../db";
import { d } from "../money";
import { conflict, badRequest } from "../errors";

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

/** Cash that may be distributed: main cash + bank in IQD minus committed obligations (payroll/expenses payable, partner payables, supplier invoices due soon). */
export async function distributableLiquidity(tx: Tx, horizonDays = 30) {
  const [cash] = await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN cash_accounts ca ON ca.account_id = jl.account_id WHERE ca.counts_toward_available_cash`;
  const [ob] = await tx`SELECT
      COALESCE((SELECT sum(jl.credit_base - jl.debit_base) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code IN ('2200','2210','2300')), 0)::text AS accrued,
      COALESCE((SELECT sum(po.total_base - COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0) * po.exchange_rate_snapshot
                                        - COALESCE((SELECT sum(r.total_base) FROM purchase_returns r WHERE r.purchase_id = po.id AND r.status = 'POSTED' AND r.settlement = 'REDUCE_PAYABLE'), 0))
                FROM purchase_orders po WHERE po.status = 'POSTED' AND po.payment_type = 'CREDIT' AND (po.due_date IS NULL OR po.due_date <= CURRENT_DATE + ${horizonDays}::int)), 0)::text AS suppliers`;
  const committed = d(ob!.accrued).plus(Decimal0(ob!.suppliers));
  return { cash: d(cash!.v), committed, available: d(cash!.v).minus(committed), accruedLiabilities: ob!.accrued as string, suppliersDue: ob!.suppliers as string };
}
const Decimal0 = (v: string) => { const x = d(v); return x.isNegative() ? d(0) : x; };
