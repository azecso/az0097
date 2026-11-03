import { secured, parse } from "@/lib/http";
import { createQuote, listQuotes, quoteSchema } from "@/lib/services/sales";
export const GET = secured({ perm: ["sales", "view"] }, ({ tx }) => listQuotes(tx));
export const POST = secured({ perm: ["sales", "create"] }, async ({ tx, principal, actor, req }) => createQuote(tx, principal, actor, parse(quoteSchema, await req.json())));
