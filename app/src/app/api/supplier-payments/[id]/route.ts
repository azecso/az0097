import { secured } from "@/lib/http";
import { deletePaymentDraft } from "@/lib/services/payments";
export const DELETE = secured({ perm: ["voucher", "edit_draft"] }, ({ tx, actor, params }) => deletePaymentDraft(tx, actor, params.id!));
