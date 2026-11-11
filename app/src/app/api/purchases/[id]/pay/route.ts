import { secured, parse } from "@/lib/http";
import { require_ } from "@/lib/authz";
import { payOnPurchase, payOnPurchaseSchema } from "@/lib/services/payments";
export const POST = secured({ perm: ["voucher", "approve"] }, async ({ tx, principal, actor, req, params }) => {
  await require_(tx, principal, "voucher", "create");
  return payOnPurchase(tx, principal, actor, params.id!, parse(payOnPurchaseSchema, await req.json()));
});
