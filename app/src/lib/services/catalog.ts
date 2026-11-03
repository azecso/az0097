import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { conflict, notFound } from "../errors";
import { currencyCode, moneyStr } from "./common";

// ---------------- contacts (customers & suppliers) ----------------
export const contactSchema = z.object({
  kind: z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]), code: z.string().min(1).max(32), name: z.string().min(2).max(200),
  phones: z.array(z.string().max(32)).max(5).default([]), address: z.string().max(500).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0), creditLimit: moneyStr.nullish(), notes: z.string().max(1000).nullish(),
});
export const contactUpdateSchema = contactSchema.partial().extend({ isArchived: z.boolean().optional(), version: z.number().int() });

export const listContacts = (tx: Tx, kind?: string, includeArchived = false) =>
  tx`SELECT id, kind, code, name, phones, address, payment_terms_days AS "paymentTermsDays", credit_limit::text AS "creditLimit", notes, is_archived AS "isArchived", version
     FROM contacts WHERE (${kind ?? null}::text IS NULL OR kind = ${kind ?? null} OR kind = 'BOTH') AND (${includeArchived} OR NOT is_archived) ORDER BY name`;

export async function createContact(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof contactSchema>) {
  const [c] = await tx`INSERT INTO contacts(company_id, kind, code, name, phones, address, payment_terms_days, credit_limit, notes, created_by)
    VALUES (${who.companyId}, ${i.kind}, ${i.code}, ${i.name}, ${i.phones}, ${i.address ?? null}, ${i.paymentTermsDays}, ${i.creditLimit ?? null}, ${i.notes ?? null}, ${who.userId})
    RETURNING id, kind, code, name, version`;
  await audit(tx, actor, { action: "contact.create", entityType: "contact", entityId: c!.id, after: i });
  return c!;
}
export async function updateContact(tx: Tx, actor: Actor, id: string, i: z.infer<typeof contactUpdateSchema>) {
  const [cur] = await tx`SELECT * FROM contacts WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل السجل من جهة أخرى");
  const [c] = await tx`UPDATE contacts SET kind = ${i.kind ?? cur.kind}, name = ${i.name ?? cur.name}, phones = ${i.phones ?? cur.phones}, address = ${i.address === undefined ? cur.address : i.address},
      payment_terms_days = ${i.paymentTermsDays ?? cur.payment_terms_days}, credit_limit = ${i.creditLimit === undefined ? cur.credit_limit : i.creditLimit},
      notes = ${i.notes === undefined ? cur.notes : i.notes}, is_archived = ${i.isArchived ?? cur.is_archived}, version = version + 1, updated_at = now()
    WHERE id = ${id} RETURNING id, kind, code, name, version, is_archived AS "isArchived"`;
  await audit(tx, actor, { action: "contact.update", entityType: "contact", entityId: id, before: { name: cur.name, kind: cur.kind, archived: cur.is_archived }, after: i });
  return c!;
}

// ---------------- products & units ----------------
export const productSchema = z.object({
  code: z.string().min(1).max(40), name: z.string().min(2).max(200), description: z.string().max(2000).nullish(), itemType: z.string().max(60).nullish(),
  specs: z.record(z.string(), z.string().max(300)).nullish(),
  baseUom: z.string().min(1).max(30), qtyDecimals: z.number().int().min(0).max(6).default(0),
  uoms: z.array(z.object({ uom: z.string().min(1).max(30), factorToBase: z.string().regex(/^\d{1,10}(\.\d{1,6})?$/) })).max(10).default([]),
  defaultPurchasePrice: moneyStr.nullish(), defaultSalePrice: moneyStr.nullish(), defaultCurrency: currencyCode.nullish(),
});
export const productUpdateSchema = productSchema.omit({ code: true }).partial().extend({ isArchived: z.boolean().optional(), version: z.number().int() });

export async function listProducts(tx: Tx, includeArchived = false) {
  return tx`SELECT p.id, p.code, p.name, p.description, p.item_type AS "itemType", p.specs, p.base_uom AS "baseUom", p.qty_decimals AS "qtyDecimals",
      p.default_purchase_price::text AS "defaultPurchasePrice", p.default_sale_price::text AS "defaultSalePrice", p.default_currency AS "defaultCurrency",
      p.is_archived AS "isArchived", p.version,
      COALESCE((SELECT json_agg(json_build_object('uom', u.uom, 'factorToBase', u.factor_to_base::text) ORDER BY u.uom) FROM product_uoms u WHERE u.product_id = p.id), '[]') AS uoms
    FROM products p WHERE ${includeArchived} OR NOT p.is_archived ORDER BY p.code`;
}

async function writeUoms(tx: Tx, companyId: string, productId: string, baseUom: string, uoms: { uom: string; factorToBase: string }[]) {
  await tx`DELETE FROM product_uoms WHERE product_id = ${productId}`;
  const seen = new Set([baseUom]);
  for (const u of uoms) {
    if (seen.has(u.uom)) throw conflict("DUPLICATE_UOM", `الوحدة ${u.uom} مكررة أو هي الوحدة الأساسية`);
    seen.add(u.uom);
    await tx`INSERT INTO product_uoms(company_id, product_id, uom, factor_to_base) VALUES (${companyId}, ${productId}, ${u.uom}, ${u.factorToBase})`;
  }
}

export async function createProduct(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof productSchema>) {
  const [p] = await tx`INSERT INTO products(company_id, code, name, description, specs, item_type, base_uom, qty_decimals, default_purchase_price, default_sale_price, default_currency, created_by)
    VALUES (${who.companyId}, ${i.code}, ${i.name}, ${i.description ?? null}, ${i.specs ? tx.json(i.specs) : null}, ${i.itemType ?? null}, ${i.baseUom}, ${i.qtyDecimals},
            ${i.defaultPurchasePrice ?? null}, ${i.defaultSalePrice ?? null}, ${i.defaultCurrency ?? null}, ${who.userId}) RETURNING id, code, name, version`;
  await writeUoms(tx, who.companyId, p!.id, i.baseUom, i.uoms);
  await audit(tx, actor, { action: "product.create", entityType: "product", entityId: p!.id, after: i });
  return p!;
}

export async function updateProduct(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof productUpdateSchema>) {
  const [cur] = await tx`SELECT * FROM products WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل السجل من جهة أخرى");
  const used = (await tx`SELECT 1 FROM stock_movements WHERE product_id = ${id} LIMIT 1`).length > 0;
  // Once there is any stock history, the unit system is frozen: changing it would silently re-interpret old quantities.
  if (used && ((i.baseUom && i.baseUom !== cur.base_uom) || (i.qtyDecimals !== undefined && i.qtyDecimals < cur.qty_decimals) || i.uoms))
    throw conflict("PRODUCT_HAS_MOVEMENTS", "لا يمكن تغيير وحدات المادة بعد وجود حركات مخزون");
  const [p] = await tx`UPDATE products SET name = ${i.name ?? cur.name}, description = ${i.description === undefined ? cur.description : i.description},
      specs = ${i.specs === undefined ? cur.specs : i.specs ? tx.json(i.specs) : null}, item_type = ${i.itemType === undefined ? cur.item_type : i.itemType},
      base_uom = ${i.baseUom ?? cur.base_uom}, qty_decimals = ${i.qtyDecimals ?? cur.qty_decimals},
      default_purchase_price = ${i.defaultPurchasePrice === undefined ? cur.default_purchase_price : i.defaultPurchasePrice},
      default_sale_price = ${i.defaultSalePrice === undefined ? cur.default_sale_price : i.defaultSalePrice},
      default_currency = ${i.defaultCurrency === undefined ? cur.default_currency : i.defaultCurrency},
      is_archived = ${i.isArchived ?? cur.is_archived}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, code, name, version, is_archived AS "isArchived"`;
  if (i.uoms) await writeUoms(tx, who.companyId, id, i.baseUom ?? cur.base_uom, i.uoms);
  await audit(tx, actor, { action: "product.update", entityType: "product", entityId: id, before: { name: cur.name, archived: cur.is_archived }, after: i });
  return p!;
}
