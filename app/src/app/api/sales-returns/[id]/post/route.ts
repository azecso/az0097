import { secured } from "@/lib/http";
import { postSalesReturn } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "approve"] }, ({ tx, principal, actor, params }) => postSalesReturn(tx, principal, actor, params.id!));
