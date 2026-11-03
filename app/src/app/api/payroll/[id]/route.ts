import { secured } from "@/lib/http";
import { deleteAccrualDraft } from "@/lib/services/expenses";
export const DELETE = secured({ perm: ["payroll", "edit_draft"] }, ({ tx, actor, params }) => deleteAccrualDraft(tx, actor, params.id!));
