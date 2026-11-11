import { secured, parse } from "@/lib/http";
import { require_ } from "@/lib/authz";
import { listRefunds, refundCredit, refundSchema } from "@/lib/services/refunds";
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx }) => listRefunds(tx));
export const POST = secured({ perm: ["voucher", "approve"] }, async ({ tx, principal, actor, req }) => { await require_(tx, principal, "voucher", "create"); return refundCredit(tx, principal, actor, parse(refundSchema, await req.json())); });
