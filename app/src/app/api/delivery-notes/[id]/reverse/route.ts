import { secured, parse } from "@/lib/http";
import { reverseDeliveryCore, reverseSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseDeliveryCore(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
