import { secured } from "@/lib/http";
import { postAdvance } from "@/lib/services/capital";
export const POST = secured({ ownerOnly: true, perm: ["personal", "approve"] }, ({ tx, principal, actor, params }) => postAdvance(tx, principal, actor, params.id!));
