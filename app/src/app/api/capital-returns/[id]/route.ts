import { secured, parse } from "@/lib/http";
import { badRequest } from "@/lib/errors";
import { capitalReturnUpdateSchema, deleteCapitalReturn, getCapitalReturn, updateCapitalReturn } from "@/lib/services/capital-returns";
export const GET = secured({ perm: ["capital", "view"] }, ({ tx, params }) => getCapitalReturn(tx, params.id!));
export const PUT = secured({ perm: ["capital", "edit_draft"] }, async ({ tx, principal, actor, req, params }) => updateCapitalReturn(tx, principal, actor, params.id!, parse(capitalReturnUpdateSchema, await req.json())));
export const DELETE = secured({ perm: ["capital", "edit_draft"] }, ({ tx, principal, actor, req, params }) => {
  const reason = new URL(req.url).searchParams.get("reason")?.trim() ?? ""; if (reason.length < 3) throw badRequest("REASON_REQUIRED", "سبب الحذف مطلوب");
  return deleteCapitalReturn(tx, principal, actor, params.id!, reason);
});
