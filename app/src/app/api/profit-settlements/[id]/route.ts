import { secured } from "@/lib/http";
import { deleteSettlementDraft } from "@/lib/services/settlements";
export const DELETE = secured({ perm: ["profit_settlement", "edit_draft"] }, ({ tx, actor, params }) => deleteSettlementDraft(tx, actor, params.id!));
