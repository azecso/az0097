import { secured, parse } from "@/lib/http";
import { debtPaymentSchema, payDebt } from "@/lib/services/personal-debts";
export const POST = secured({ perm: ["personal", "create"] }, async ({ tx, principal, actor, req, params }) => payDebt(tx, principal, actor, params.id!, parse(debtPaymentSchema, await req.json())));
