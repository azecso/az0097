import { secured, parse } from "@/lib/http";
import { createSalesReturn, listSalesReturns, salesReturnSchema } from "@/lib/services/sales";
export const GET = secured({ perm: ["sales", "view"] }, ({ tx }) => listSalesReturns(tx));
export const POST = secured({ perm: ["sales", "create"] }, async ({ tx, principal, actor, req }) => createSalesReturn(tx, principal, actor, parse(salesReturnSchema, await req.json())));
