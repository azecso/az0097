import { secured, parse } from "@/lib/http";
import { cashAccountSchema, createCashAccount } from "@/lib/services/cash";
import { cashAccounts } from "@/lib/services/reports";
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx }) => cashAccounts(tx));
export const POST = secured({ ownerOnly: true }, async ({ tx, principal, actor, req }) => createCashAccount(tx, principal, actor, parse(cashAccountSchema, await req.json())));
