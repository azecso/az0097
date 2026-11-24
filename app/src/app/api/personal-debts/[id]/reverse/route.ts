import { secured, parse } from "@/lib/http";
import { reverseDebt, reverseDebtSchema } from "@/lib/services/personal-debts";
export const POST = secured({ perm: ["personal", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseDebt(tx, principal, actor, params.id!, parse(reverseDebtSchema, await req.json()).reason));
