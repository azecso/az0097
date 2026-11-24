import { secured, parse } from "@/lib/http";
import { createDebt, debtSchema, debtTotals, listDebts } from "@/lib/services/personal-debts";
export const GET = secured({ perm: ["personal", "view"] }, async ({ tx }) => ({ rows: await listDebts(tx), totals: await debtTotals(tx) }));
export const POST = secured({ perm: ["personal", "create"] }, async ({ tx, principal, actor, req }) => createDebt(tx, principal, actor, parse(debtSchema, await req.json())));
