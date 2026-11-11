import { secured } from "@/lib/http";
import { getPaymentForEdit } from "@/lib/services/payments";
export const GET = secured({ perm: ["voucher", "cancel"] }, ({ tx, params }) => getPaymentForEdit(tx, params.id!));
