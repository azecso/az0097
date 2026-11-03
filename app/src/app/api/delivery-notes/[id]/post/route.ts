import { secured } from "@/lib/http";
import { postDelivery } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "approve"] }, ({ tx, principal, actor, params }) => postDelivery(tx, principal, actor, params.id!));
