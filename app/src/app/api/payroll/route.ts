import { secured, parse } from "@/lib/http";
import { generateAccruals, generateSchema, listAccruals } from "@/lib/services/expenses";
export const GET = secured({ perm: ["payroll", "view"] }, ({ tx, req }) => listAccruals(tx, new URL(req.url).searchParams.get("month") ?? undefined));
export const POST = secured({ perm: ["payroll", "create"] }, async ({ tx, principal, actor, req }) => generateAccruals(tx, principal, actor, parse(generateSchema, await req.json()).month));
