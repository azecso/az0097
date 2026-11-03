import { secured, parse } from "@/lib/http";
import { reversePurchase, reverseSchema } from "@/lib/services/purchases";
export const POST = secured({ perm: ["purchase", "cancel"] }, async ({ tx, principal, actor, req, params }) => reversePurchase(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
