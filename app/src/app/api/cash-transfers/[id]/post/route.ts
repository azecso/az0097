import { secured } from "@/lib/http";
import { postCashTransfer } from "@/lib/services/receipts";
export const POST = secured({ perm: ["voucher", "approve"] }, ({ tx, principal, actor, params }) => postCashTransfer(tx, principal, actor, params.id!));
