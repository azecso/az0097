import { secured } from "@/lib/http";
import { deleteReceiptDraft } from "@/lib/services/receipts";
export const DELETE = secured({ perm: ["voucher", "edit_draft"] }, ({ tx, actor, params }) => deleteReceiptDraft(tx, actor, params.id!));
