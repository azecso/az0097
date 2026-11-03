import { secured, parse } from "@/lib/http";
import { payAccrual, payrollPaySchema } from "@/lib/services/expenses";
export const POST = secured({ perm: ["payroll", "approve"] }, async ({ tx, principal, actor, req }) => payAccrual(tx, principal, actor, parse(payrollPaySchema, await req.json())));
