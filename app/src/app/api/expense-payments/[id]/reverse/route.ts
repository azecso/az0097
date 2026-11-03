import { secured, parse } from "@/lib/http";
import { reverseExpensePayment } from "@/lib/services/expenses";
import { reverseSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["expense", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseExpensePayment(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
