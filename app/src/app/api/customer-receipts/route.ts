import { secured, parse } from "@/lib/http";
import { createReceipt, listReceipts, receiptSchema } from "@/lib/services/receipts";
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx }) => listReceipts(tx));
export const POST = secured({ perm: ["voucher", "create"] }, async ({ tx, principal, actor, req }) => createReceipt(tx, principal, actor, parse(receiptSchema, await req.json())));
