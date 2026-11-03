import { secured } from "@/lib/http";
import { postAccrual } from "@/lib/services/expenses";
export const POST = secured({ perm: ["payroll", "approve"] }, ({ tx, principal, actor, params }) => postAccrual(tx, principal, actor, params.id!));
