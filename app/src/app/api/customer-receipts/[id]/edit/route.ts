import { secured } from "@/lib/http";
import { getReceiptForEdit } from "@/lib/services/receipts";
export const GET = secured({ perm: ["voucher", "cancel"] }, ({ tx, params }) => getReceiptForEdit(tx, params.id!));
