import { secured, parse } from "@/lib/http";
import { createPayment, listPayments, paymentSchema } from "@/lib/services/payments";
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx }) => listPayments(tx));
export const POST = secured({ perm: ["voucher", "create"] }, async ({ tx, principal, actor, req }) => createPayment(tx, principal, actor, parse(paymentSchema, await req.json())));
