import { secured, parse } from "@/lib/http";
import { companySchema, getCompany, updateCompany } from "@/lib/services/company";

export const GET = secured({ perm: ["company", "view"] }, ({ tx }) => getCompany(tx));
export const PATCH = secured({ perm: ["company", "edit_draft"] }, async ({ tx, principal, actor, req }) =>
  updateCompany(tx, principal, actor, parse(companySchema, await req.json())));
