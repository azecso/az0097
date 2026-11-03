import { secured } from "@/lib/http";
import { deleteDeliveryDraft } from "@/lib/services/sales";
export const DELETE = secured({ perm: ["sales", "edit_draft"] }, ({ tx, actor, params }) => deleteDeliveryDraft(tx, actor, params.id!));
