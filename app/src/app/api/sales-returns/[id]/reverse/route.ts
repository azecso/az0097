import { secured, parse } from "@/lib/http";
import { reverseSalesReturn, reverseSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseSalesReturn(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
