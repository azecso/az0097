import { secured } from "@/lib/http";
import { postTransfer } from "@/lib/services/stock-docs";
export const POST = secured({ perm: ["stock_transfer", "approve"] }, ({ tx, principal, actor, params }) => postTransfer(tx, principal, actor, params.id!));
