import { secured, parse } from "@/lib/http";
import { deleteInvoiceDraft, getInvoice, invoiceUpdateSchema, updateInvoice } from "@/lib/services/sales";
export const GET = secured({ perm: ["sales", "view"] }, ({ tx, params }) => getInvoice(tx, params.id!));
export const PUT = secured({ perm: ["sales", "edit_draft"] }, async ({ tx, principal, actor, req, params }) => updateInvoice(tx, principal, actor, params.id!, parse(invoiceUpdateSchema, await req.json())));
export const DELETE = secured({ perm: ["sales", "edit_draft"] }, ({ tx, actor, params }) => deleteInvoiceDraft(tx, actor, params.id!));
