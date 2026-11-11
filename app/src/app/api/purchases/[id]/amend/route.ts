import { secured, parse } from "@/lib/http";
import { amendPurchase, purchaseUpdateSchema } from "@/lib/services/purchases";
export const POST = secured({ perm: ["purchase", "cancel"] }, async ({ tx, principal, actor, req, params }) => amendPurchase(tx, principal, actor, params.id!, parse(purchaseUpdateSchema, await req.json())));
