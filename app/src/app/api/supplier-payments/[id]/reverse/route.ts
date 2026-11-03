import { secured, parse } from "@/lib/http";
import { reversePayment } from "@/lib/services/payments";
import { reverseSchema } from "@/lib/services/purchases";
export const POST = secured({ perm: ["voucher", "cancel"] }, async ({ tx, principal, actor, req, params }) => reversePayment(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
