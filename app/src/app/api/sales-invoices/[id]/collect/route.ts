import { secured, parse } from "@/lib/http";
import { require_ } from "@/lib/authz";
import { collectOnInvoice, collectSchema } from "@/lib/services/receipts";
export const POST = secured({ perm: ["voucher", "approve"] }, async ({ tx, principal, actor, req, params }) => {
  await require_(tx, principal, "voucher", "create");
  return collectOnInvoice(tx, principal, actor, params.id!, parse(collectSchema, await req.json()));
});
