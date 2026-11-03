import { secured, parse } from "@/lib/http";
import { deletePurchaseDraft, getPurchase, purchaseUpdateSchema, updatePurchase } from "@/lib/services/purchases";
export const GET = secured({ perm: ["purchase", "view"] }, ({ tx, params }) => getPurchase(tx, params.id!));
export const PUT = secured({ perm: ["purchase", "edit_draft"] }, async ({ tx, principal, actor, req, params }) => updatePurchase(tx, principal, actor, params.id!, parse(purchaseUpdateSchema, await req.json())));
export const DELETE = secured({ perm: ["purchase", "edit_draft"] }, ({ tx, actor, params }) => deletePurchaseDraft(tx, actor, params.id!));
