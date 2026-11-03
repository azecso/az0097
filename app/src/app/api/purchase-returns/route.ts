import { secured, parse } from "@/lib/http";
import { createReturn, listReturns, returnSchema } from "@/lib/services/purchases";
export const GET = secured({ perm: ["purchase", "view"] }, ({ tx }) => listReturns(tx));
export const POST = secured({ perm: ["purchase", "create"] }, async ({ tx, principal, actor, req }) => createReturn(tx, principal, actor, parse(returnSchema, await req.json())));
