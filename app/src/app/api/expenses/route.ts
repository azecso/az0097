import { secured, parse } from "@/lib/http";
import { createExpense, expenseSchema, listExpenses } from "@/lib/services/expenses";
export const GET = secured({ perm: ["expense", "view"] }, ({ tx, req }) => listExpenses(tx, new URL(req.url).searchParams.get("status") ?? undefined));
export const POST = secured({ perm: ["expense", "create"] }, async ({ tx, principal, actor, req }) => createExpense(tx, principal, actor, parse(expenseSchema, await req.json())));
