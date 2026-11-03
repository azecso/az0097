import { secured } from "@/lib/http";
import { deleteTransferDraft } from "@/lib/services/stock-docs";
export const DELETE = secured({ perm: ["stock_transfer", "edit_draft"] }, ({ tx, actor, params }) => deleteTransferDraft(tx, actor, params.id!));
