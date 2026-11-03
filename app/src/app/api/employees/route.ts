import { secured, parse } from "@/lib/http";
import { createEmployee, employeeSchema, listEmployees } from "@/lib/services/expenses";
export const GET = secured({ perm: ["payroll", "view"] }, ({ tx }) => listEmployees(tx));
export const POST = secured({ perm: ["payroll", "create"] }, async ({ tx, principal, actor, req }) => createEmployee(tx, principal, actor, parse(employeeSchema, await req.json())));
