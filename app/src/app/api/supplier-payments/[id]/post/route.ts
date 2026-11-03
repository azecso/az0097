import { secured } from "@/lib/http";
import { postPayment } from "@/lib/services/payments";
export const POST = secured({ perm: ["voucher", "approve"] }, ({ tx, principal, actor, params }) => postPayment(tx, principal, actor, params.id!));
