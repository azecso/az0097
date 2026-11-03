import { secured } from "@/lib/http";
import { deleteSalesReturnDraft } from "@/lib/services/sales";
export const DELETE = secured({ perm: ["sales", "edit_draft"] }, ({ tx, actor, params }) => deleteSalesReturnDraft(tx, actor, params.id!));
