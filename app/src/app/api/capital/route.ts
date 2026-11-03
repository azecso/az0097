import { secured, parse } from "@/lib/http";
import { capitalBalance, capitalSchema, listCapital, requestCapital } from "@/lib/services/capital";
export const GET = secured({ perm: ["capital", "view"] }, async ({ tx }) => ({ balance: (await capitalBalance(tx)).toString(), transactions: await listCapital(tx) }));
export const POST = secured({ perm: ["capital", "create"] }, async ({ tx, principal, actor, req }) => requestCapital(tx, principal, actor, parse(capitalSchema, await req.json())));
