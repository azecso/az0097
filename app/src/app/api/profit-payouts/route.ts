import { secured, parse } from "@/lib/http";
import { listPayouts, payoutSchema, payProfit } from "@/lib/services/settlements";
export const GET = secured({ perm: ["profit_payout", "view"] }, ({ tx }) => listPayouts(tx));
export const POST = secured({ ownerOnly: true, perm: ["profit_payout", "approve"] }, async ({ tx, principal, actor, req }) => payProfit(tx, principal, actor, parse(payoutSchema, await req.json())));
