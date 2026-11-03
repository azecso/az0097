import { secured, parse } from "@/lib/http";
import { createTransfer, listTransfers, transferSchema } from "@/lib/services/stock-docs";
export const GET = secured({ perm: ["stock_transfer", "view"] }, ({ tx }) => listTransfers(tx));
export const POST = secured({ perm: ["stock_transfer", "create"] }, async ({ tx, principal, actor, req }) => createTransfer(tx, principal, actor, parse(transferSchema, await req.json())));
