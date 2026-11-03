import { secured } from "@/lib/http";
import { deleteCountDraft } from "@/lib/services/stock-docs";
export const DELETE = secured({ perm: ["inventory_count", "edit_draft"] }, ({ tx, actor, params }) => deleteCountDraft(tx, actor, params.id!));
