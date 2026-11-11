import { secured, parse } from "@/lib/http";
import { reverseInvoice, reverseSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "cancel"] }, async ({ tx, principal, actor, req, params }) => (async () => { const b = parse(reverseSchema, await req.json()); return reverseInvoice(tx, principal, actor, params.id!, b.reason, b.cascade, b.receiptHandling); })());
