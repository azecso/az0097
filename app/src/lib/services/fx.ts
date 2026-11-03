import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest } from "../errors";

export const fxSchema = z.object({
  currency: z.string().length(3),
  rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rate: z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, "رقم عشري صحيح"),     // string on the wire: never a JS float
});

/** Convention: IQD per 1 unit of the foreign currency. Base currency IQD has no rate row (always 1). */
export async function upsertRate(tx: Tx, who: Principal, actor: Actor, input: z.infer<typeof fxSchema>) {
  const [company] = await tx`SELECT base_currency FROM companies WHERE id = ${who.companyId}`;
  if (input.currency === company!.base_currency) throw badRequest("BASE_CURRENCY_RATE", "عملة الأساس سعرها ثابت 1");
  const [cur] = await tx`SELECT 1 FROM currencies WHERE code = ${input.currency}`;
  if (!cur) throw badRequest("UNKNOWN_CURRENCY");
  const r = new Decimal(input.rate);
  if (r.lte(0)) throw badRequest("INVALID_RATE", "السعر يجب أن يكون موجباً");
  if (r.lt(1) || r.gt(100000)) throw badRequest("RATE_OUT_OF_RANGE", "السعر خارج المدى المعقول (IQD لكل 1 USD)");
  const [prev] = await tx`SELECT id, rate::text AS rate FROM fx_rates WHERE currency = ${input.currency} AND rate_date = ${input.rateDate} FOR UPDATE`;
  const [row] = prev
    ? await tx`UPDATE fx_rates SET rate = ${input.rate}, updated_by = ${who.userId}, updated_at = now() WHERE id = ${prev.id}
               RETURNING id, currency, rate_date::text AS "rateDate", rate::text AS rate`
    : await tx`INSERT INTO fx_rates(company_id, currency, rate_date, rate, created_by) VALUES (${who.companyId}, ${input.currency}, ${input.rateDate}, ${input.rate}, ${who.userId})
               RETURNING id, currency, rate_date::text AS "rateDate", rate::text AS rate`;
  await audit(tx, actor, { action: prev ? "fx.update" : "fx.create", entityType: "fx_rate", entityId: row!.id,
    before: prev ? { rate: prev.rate } : undefined, after: { currency: input.currency, rateDate: input.rateDate, rate: row!.rate } });
  return row!;
}

export async function listRates(tx: Tx, currency?: string) {
  return tx`SELECT id, currency, rate_date::text AS "rateDate", rate::text AS rate FROM fx_rates
            WHERE (${currency ?? null}::text IS NULL OR currency = ${currency ?? null}) ORDER BY rate_date DESC LIMIT 200`;
}

/** Latest rate on or before the date; documents snapshot this value (rate is then frozen on the document). */
export async function rateOn(tx: Tx, currency: string, date: string) {
  const [r] = await tx`SELECT rate::text AS rate, rate_date::text AS "rateDate" FROM fx_rates
    WHERE currency = ${currency} AND rate_date <= ${date} ORDER BY rate_date DESC LIMIT 1`;
  return r ?? null;
}
