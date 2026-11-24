import { secured, parse } from "@/lib/http";
import { reverseDebtPayment, reverseDebtSchema } from "@/lib/services/personal-debts";
export const POST = secured({ perm: ["personal", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseDebtPayment(tx, principal, actor, params.id!, parse(reverseDebtSchema, await req.json()).reason));
