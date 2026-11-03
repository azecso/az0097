import { secured, parse } from "@/lib/http";
import { cashTransferSchema, createCashTransfer, listCashTransfers } from "@/lib/services/receipts";
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx }) => listCashTransfers(tx));
export const POST = secured({ perm: ["voucher", "create"] }, async ({ tx, principal, actor, req }) => createCashTransfer(tx, principal, actor, parse(cashTransferSchema, await req.json())));
