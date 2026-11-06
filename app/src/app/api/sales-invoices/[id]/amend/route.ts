import { secured, parse } from "@/lib/http";
import { amendInvoice, invoiceUpdateSchema } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "cancel"] }, async ({ tx, principal, actor, req, params }) => amendInvoice(tx, principal, actor, params.id!, parse(invoiceUpdateSchema, await req.json())));
