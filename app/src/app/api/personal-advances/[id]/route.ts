import { secured } from "@/lib/http";
import { deleteAdvanceDraft } from "@/lib/services/capital";
export const DELETE = secured({ perm: ["personal", "edit_draft"] }, ({ tx, actor, params }) => deleteAdvanceDraft(tx, actor, params.id!));
