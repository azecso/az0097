import { secured } from "@/lib/http";
import { postReceipt } from "@/lib/services/receipts";
export const POST = secured({ perm: ["voucher", "approve"] }, ({ tx, principal, actor, params }) => postReceipt(tx, principal, actor, params.id!));
