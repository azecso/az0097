import { secured, parse } from "@/lib/http";
import { reversePayrollPayment } from "@/lib/services/expenses";
import { reverseSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["payroll", "cancel"] }, async ({ tx, principal, actor, req, params }) => reversePayrollPayment(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
