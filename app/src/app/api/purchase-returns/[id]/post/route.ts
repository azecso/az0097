import { secured } from "@/lib/http";
import { postReturn } from "@/lib/services/purchases";
export const POST = secured({ perm: ["purchase", "approve"] }, ({ tx, principal, actor, params }) => postReturn(tx, principal, actor, params.id!));
