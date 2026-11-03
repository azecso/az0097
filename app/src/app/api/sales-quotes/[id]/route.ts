import { secured, parse } from "@/lib/http";
import { deleteQuoteDraft, getQuote, quoteUpdateSchema, updateQuote } from "@/lib/services/sales";
export const GET = secured({ perm: ["sales", "view"] }, ({ tx, params }) => getQuote(tx, params.id!));
export const PUT = secured({ perm: ["sales", "edit_draft"] }, async ({ tx, principal, actor, req, params }) => updateQuote(tx, principal, actor, params.id!, parse(quoteUpdateSchema, await req.json())));
export const DELETE = secured({ perm: ["sales", "edit_draft"] }, ({ tx, actor, params }) => deleteQuoteDraft(tx, actor, params.id!));
