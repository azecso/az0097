import { secured, parse } from "@/lib/http";
import { require_ } from "@/lib/authz";
import { receiveUsd, usdReceiptSchema } from "@/lib/services/receipts";
export const POST = secured({ perm: ["voucher", "approve"] }, async ({ tx, principal, actor, req }) => {
  await require_(tx, principal, "voucher", "create");
  return receiveUsd(tx, principal, actor, parse(usdReceiptSchema, await req.json()));
});
