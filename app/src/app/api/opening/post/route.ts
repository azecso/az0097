import { secured } from "@/lib/http";
import { postOpening } from "@/lib/services/opening";
export const POST = secured({ ownerOnly: true, perm: ["opening_balance", "approve"] }, ({ tx, principal, actor }) => postOpening(tx, principal, actor));
