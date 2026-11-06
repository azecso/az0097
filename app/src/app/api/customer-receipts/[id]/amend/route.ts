import { secured, parse } from "@/lib/http";
import { amendReceipt, receiptUpdateSchema } from "@/lib/services/receipts";
export const POST = secured({ perm: ["voucher", "cancel"] }, async ({ tx, principal, actor, req, params }) => amendReceipt(tx, principal, actor, params.id!, parse(receiptUpdateSchema, await req.json())));
