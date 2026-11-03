import { secured, parse } from "@/lib/http";
import { reverseTransfer } from "@/lib/services/stock-docs";
import { reverseSchema } from "@/lib/services/purchases";
export const POST = secured({ perm: ["stock_transfer", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseTransfer(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
