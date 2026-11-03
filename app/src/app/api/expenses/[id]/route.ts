import { secured } from "@/lib/http";
import { deleteExpenseDraft } from "@/lib/services/expenses";
export const DELETE = secured({ perm: ["expense", "edit_draft"] }, ({ tx, actor, params }) => deleteExpenseDraft(tx, actor, params.id!));
