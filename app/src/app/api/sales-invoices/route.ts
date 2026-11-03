import { secured, parse } from "@/lib/http";
import { createInvoice, invoiceSchema, listInvoices } from "@/lib/services/sales";
export const GET = secured({ perm: ["sales", "view"] }, ({ tx, req }) => listInvoices(tx, new URL(req.url).searchParams.get("status") ?? undefined));
export const POST = secured({ perm: ["sales", "create"] }, async ({ tx, principal, actor, req }) => createInvoice(tx, principal, actor, parse(invoiceSchema, await req.json())));
