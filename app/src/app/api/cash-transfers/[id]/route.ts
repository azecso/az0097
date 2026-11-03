import { getCashTransfer } from "@/lib/services/receipts";
import { secured } from "@/lib/http";
import { deleteCashTransferDraft } from "@/lib/services/receipts";
export const DELETE = secured({ perm: ["voucher", "edit_draft"] }, ({ tx, actor, params }) => deleteCashTransferDraft(tx, actor, params.id!));

export const GET = secured({ perm: ["voucher", "view"] }, ({ tx, params }) => getCashTransfer(tx, params.id!));
