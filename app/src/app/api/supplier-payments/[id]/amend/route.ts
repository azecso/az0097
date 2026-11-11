import { secured, parse } from "@/lib/http";
import { amendPayment, paymentUpdateSchema } from "@/lib/services/payments";
export const POST = secured({ perm: ["voucher", "cancel"] }, async ({ tx, principal, actor, req, params }) => amendPayment(tx, principal, actor, params.id!, parse(paymentUpdateSchema, await req.json())));
