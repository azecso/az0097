import { secured, parse } from "@/lib/http";
import { expensePaymentSchema, payExpense } from "@/lib/services/expenses";
export const POST = secured({ perm: ["expense", "approve"] }, async ({ tx, principal, actor, req }) => payExpense(tx, principal, actor, parse(expensePaymentSchema, await req.json())));
