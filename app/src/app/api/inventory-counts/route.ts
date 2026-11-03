import { secured, parse } from "@/lib/http";
import { countSchema, createCount, listCounts } from "@/lib/services/stock-docs";
export const GET = secured({ perm: ["inventory_count", "view"] }, ({ tx }) => listCounts(tx));
export const POST = secured({ perm: ["inventory_count", "create"] }, async ({ tx, principal, actor, req }) => createCount(tx, principal, actor, parse(countSchema, await req.json())));
