// ALL money arithmetic goes through decimal.js. Never JS numbers/floats. Values travel as strings.
import Decimal from "decimal.js";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const CURRENCY_DECIMALS: Record<string, number> = { IQD: 0, USD: 2 };

export function d(v: Decimal.Value): Decimal { return new Decimal(v); }

/** Round to the currency's minor-unit precision (IQD 0, USD 2), half-up. */
export function roundMoney(v: Decimal.Value, currency: string): Decimal {
  const dec = CURRENCY_DECIMALS[currency];
  if (dec === undefined) throw new Error(`unknown currency ${currency}`);
  return d(v).toDecimalPlaces(dec, Decimal.ROUND_HALF_UP);
}

/** Rate convention: IQD per 1 USD. amount_base = round(amount * rate, base decimals). */
export function toBase(amount: Decimal.Value, rate: Decimal.Value, currency: string, base = "IQD"): Decimal {
  if (currency === base) return roundMoney(amount, base);
  return roundMoney(d(amount).mul(rate), base);
}

/** Equal split of an approved distributable amount: partner gets floor(D/2), owner gets the remainder. */
export function split5050(distributable: Decimal.Value, currency = "IQD") {
  const dec = CURRENCY_DECIMALS[currency] ?? 0;
  const partner = d(distributable).div(2).toDecimalPlaces(dec, Decimal.ROUND_DOWN);
  return { partner, owner: d(distributable).minus(partner) };
}
