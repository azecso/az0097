import { secured } from "@/lib/http";
import { postPurchase } from "@/lib/services/purchases";
export const POST = secured({ perm: ["purchase", "approve"] }, ({ tx, principal, actor, params }) => postPurchase(tx, principal, actor, params.id!));
