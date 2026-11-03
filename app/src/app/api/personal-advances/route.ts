import { secured, parse } from "@/lib/http";
import { advanceSchema, createAdvance, listAdvances } from "@/lib/services/capital";
export const GET = secured({ perm: ["personal", "view"] }, ({ tx }) => listAdvances(tx));
export const POST = secured({ perm: ["personal", "create"] }, async ({ tx, principal, actor, req }) => createAdvance(tx, principal, actor, parse(advanceSchema, await req.json())));
