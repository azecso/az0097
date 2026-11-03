import { secured } from "@/lib/http";
import { deleteOpening } from "@/lib/services/opening";
export const DELETE = secured({ perm: ["opening_balance", "edit_draft"] }, ({ tx, actor, params }) => deleteOpening(tx, actor, params.id!));
