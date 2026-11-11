import type { Decimal } from "decimal.js";
import { d, toBase } from "./money";
import type { JLine } from "./ledger";

/**
 * Settling a foreign-currency LIABILITY (policy: docs/ACCOUNTING_POLICY.md §4): the liability is cleared at the rate it was booked at,
 * cash leaves at the payment-date rate, and the difference is a realised FX result in 7100 (loss = Dr, gain = Cr). Never an expense of the operation.
 */
export function settleLiability(o: { liabilityAccount: string; cashAccount: string; currency: string; amount: Decimal.Value; bookedRate: Decimal.Value; paymentRate: Decimal.Value; partnerId?: string | null; contactId?: string | null }) {
  const liabBase = toBase(o.amount, o.bookedRate, o.currency), cashBase = toBase(o.amount, o.paymentRate, o.currency), diff = cashBase.minus(liabBase);   // + = paid more dinars than booked (loss)
  const lines: JLine[] = [
    { account: o.liabilityAccount, debit: liabBase, currency: o.currency, amountOrig: o.amount, fx: o.bookedRate, partnerId: o.partnerId ?? null, contactId: o.contactId ?? null },
    { account: o.cashAccount, credit: cashBase, currency: o.currency, amountOrig: o.amount, fx: o.paymentRate }];
  if (diff.gt(0)) lines.push({ account: "7100", debit: diff, memo: "خسارة فرق صرف محققة" });
  if (diff.lt(0)) lines.push({ account: "7100", credit: diff.abs(), memo: "ربح فرق صرف محقق" });
  return { liabBase, cashBase, diff, lines };
}
export const isForeign = (cur: string) => d(cur === "IQD" ? 0 : 1).gt(0);
