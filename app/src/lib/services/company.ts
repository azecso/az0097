import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { conflict, notFound } from "../errors";

export async function getCompany(tx: Tx) {
  const [c] = await tx`SELECT id, name, name_en AS "nameEn", address, phones, base_currency AS "baseCurrency",
      allow_negative_stock AS "allowNegativeStock", landed_cost_policy AS "landedCostPolicy", version FROM companies`;
  if (!c) throw notFound();
  return c;
}
export const companySchema = z.object({
  name: z.string().min(2).max(200), nameEn: z.string().max(200).nullish(), address: z.string().max(500).nullish(),
  phones: z.array(z.string().max(32)).max(5).default([]),
  allowNegativeStock: z.boolean().default(false),
  landedCostPolicy: z.enum(["EXCLUDE", "INCLUDE"]).default("EXCLUDE"),
  version: z.number().int(),
});
export async function updateCompany(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof companySchema>) {
  const before = await getCompany(tx);
  if (before.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل بيانات الشركة من جهة أخرى");
  await tx`UPDATE companies SET name=${i.name}, name_en=${i.nameEn ?? null}, address=${i.address ?? null}, phones=${i.phones},
      allow_negative_stock=${i.allowNegativeStock}, landed_cost_policy=${i.landedCostPolicy}, version=version+1, updated_at=now()
    WHERE id=${who.companyId}`;
  const after = await getCompany(tx);
  await audit(tx, actor, { action: "company.update", entityType: "company", entityId: who.companyId, before, after });
  return after;
}
