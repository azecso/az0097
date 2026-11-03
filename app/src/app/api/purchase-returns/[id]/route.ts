import { secured } from "@/lib/http";
import { deleteReturnDraft } from "@/lib/services/purchases";
export const DELETE = secured({ perm: ["purchase", "edit_draft"] }, ({ tx, actor, params }) => deleteReturnDraft(tx, actor, params.id!));
