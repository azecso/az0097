import { secured, parse } from "@/lib/http";
import { amendUsdReceipt, usdReceiptUpdateSchema } from "@/lib/services/receipts";
export const POST = secured({ perm: ["voucher", "cancel"] }, async ({ tx, principal, actor, req, params }) => amendUsdReceipt(tx, principal, actor, params.id!, parse(usdReceiptUpdateSchema, await req.json())));
