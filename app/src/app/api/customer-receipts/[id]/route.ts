import { getReceipt } from "@/lib/services/receipts";
import { secured } from "@/lib/http";
import { deleteReceiptDraft } from "@/lib/services/receipts";
export const DELETE = secured({ perm: ["voucher", "edit_draft"] }, ({ tx, actor, params }) => deleteReceiptDraft(tx, actor, params.id!));

export const GET = secured({ perm: ["voucher", "view"] }, ({ tx, params }) => getReceipt(tx, params.id!));
