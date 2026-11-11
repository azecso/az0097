import { secured, parse } from "@/lib/http";
import { reverseRefund } from "@/lib/services/refunds";
import { reverseSchema } from "@/lib/services/purchases";
export const POST = secured({ perm: ["voucher", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseRefund(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
