import { secured } from "@/lib/http";
import { postExpense } from "@/lib/services/expenses";
export const POST = secured({ perm: ["expense", "approve"] }, ({ tx, principal, actor, params }) => postExpense(tx, principal, actor, params.id!));
