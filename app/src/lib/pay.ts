import Decimal from "decimal.js";

/** Payment state of a POSTED invoice from its outstanding amount (exact decimals, never floats). */
export type PayState = { key: "PAID" | "PARTIAL" | "UNPAID"; outstanding: string };
export function payState(status: string, total: string, outstanding: string | null | undefined): PayState | null {
  if (status !== "POSTED" || outstanding === null || outstanding === undefined) return null;
  const out = new Decimal(outstanding), tot = new Decimal(total);
  if (out.lte(0)) return { key: "PAID", outstanding: "0" };
  return { key: out.gte(tot) ? "UNPAID" : "PARTIAL", outstanding: out.toString() };
}
/** Totals per currency over POSTED rows only: document total, paid and remaining. */
export function totalsByCurrency<T extends { status: string; currency: string; outstanding?: string | null }>(rows: T[], total: (r: T) => string) {
  const m = new Map<string, { total: Decimal; outstanding: Decimal }>();
  for (const r of rows) {
    if (r.status !== "POSTED") continue;
    const e = m.get(r.currency) ?? { total: new Decimal(0), outstanding: new Decimal(0) };
    e.total = e.total.plus(total(r)); e.outstanding = e.outstanding.plus(Decimal.max(0, new Decimal(r.outstanding ?? 0)));
    m.set(r.currency, e);
  }
  return [...m].map(([currency, e]) => ({ currency, total: e.total.toString(), paid: e.total.minus(e.outstanding).toString(), outstanding: e.outstanding.toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
}
