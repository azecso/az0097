import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { Tx } from "../db";
import { d } from "../money";
import { badRequest, conflict, notFound } from "../errors";
import { rateOn } from "./fx";

export const qtyStr = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, "كمية غير صالحة").refine((v) => d(v).gt(0), "يجب أن تكون الكمية موجبة");
export const moneyStr = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "مبلغ غير صالح");
export const rateStr = z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, "سعر صرف غير صالح");
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح").refine((v) => !Number.isNaN(Date.parse(v)), "تاريخ غير صالح");
export const uuid = z.string().uuid();
export const currencyCode = z.enum(["IQD", "USD"]);

export const draftRef = () => "DRAFT-" + randomBytes(4).toString("hex").toUpperCase();
export const yearOf = (date: string) => Number(date.slice(0, 4));

/** Document exchange-rate snapshot: explicit rate (manual per document) or the latest daily rate on/before the date. */
export async function resolveRate(tx: Tx, currency: string, date: string, explicit?: string): Promise<string> {
  if (currency === "IQD") return "1";
  if (explicit) { const n = d(explicit); if (n.lt(1) || n.gt(100000)) throw badRequest("RATE_OUT_OF_RANGE"); return explicit; }
  const r = await rateOn(tx, currency, date);
  if (!r) throw badRequest("NO_FX_RATE", "لا يوجد سعر صرف لهذا التاريخ؛ أدخل السعر يدوياً أو سجّل سعر اليوم");
  return r.rate;
}

export interface ProductUom { id: string; code: string; base_uom: string; qty_decimals: number; is_archived: boolean; factors: Map<string, string> }

/** Converts (qty, uom) to the base unit with the product's own conversion; refuses precision the product cannot hold. */
export async function toBaseQty(tx: Tx, productId: string, uom: string, qty: string): Promise<string> {
  const [p] = await tx`SELECT id, base_uom, qty_decimals, is_archived FROM products WHERE id = ${productId}`;
  if (!p) throw notFound();
  if (p.is_archived) throw conflict("PRODUCT_ARCHIVED", "المادة مؤرشفة");
  let factor = d(1);
  if (uom !== p.base_uom) {
    const [u] = await tx`SELECT factor_to_base::text AS f FROM product_uoms WHERE product_id = ${productId} AND uom = ${uom}`;
    if (!u) throw badRequest("UNKNOWN_UOM", `الوحدة ${uom} غير معرّفة لهذه المادة`);
    factor = d(u.f);
  }
  const base = d(qty).mul(factor);
  if (base.decimalPlaces() > p.qty_decimals) throw badRequest("BAD_QTY_PRECISION", `الكمية الأساسية تتجاوز دقة المادة (${p.qty_decimals} منازل)`);
  return base.toString();
}

export async function mainLocationId(tx: Tx, kind: "MAIN" | "PARTNER_CUSTODY" = "MAIN"): Promise<string> {
  const [r] = await tx`SELECT sl.id FROM stock_locations sl JOIN warehouses w ON w.id = sl.warehouse_id WHERE w.kind = ${kind} LIMIT 1`;
  if (!r) throw conflict("LOCATION_NOT_FOUND");
  return r.id as string;
}
