import { secured, parse } from "@/lib/http";
import { capitalReturnSchema, capitalReturnTotals, createCapitalReturn, listCapitalReturns } from "@/lib/services/capital-returns";
const f = (req: Request) => { const u = new URL(req.url).searchParams; return { from: u.get("from") || undefined, to: u.get("to") || undefined, q: u.get("q") || undefined }; };
export const GET = secured({ perm: ["capital", "view"] }, async ({ tx, req }) => ({ rows: await listCapitalReturns(tx, f(req)), totals: await capitalReturnTotals(tx, f(req)) }));
export const POST = secured({ perm: ["capital", "create"] }, async ({ tx, principal, actor, req }) => createCapitalReturn(tx, principal, actor, parse(capitalReturnSchema, await req.json())));
