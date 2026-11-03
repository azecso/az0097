import { secured, parse } from "@/lib/http";
import { reverseReceipt } from "@/lib/services/receipts";
import { reverseSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["voucher", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseReceipt(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
