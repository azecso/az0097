import { secured, parse } from "@/lib/http";
import { createDebt, debtSchema, listDebts } from "@/lib/services/capital";
export const GET = secured({ perm: ["personal", "view"] }, ({ tx }) => listDebts(tx));
export const POST = secured({ perm: ["personal", "create"] }, async ({ tx, principal, actor, req }) => createDebt(tx, principal, actor, parse(debtSchema, await req.json())));
