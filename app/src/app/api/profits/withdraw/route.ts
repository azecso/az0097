import { secured, parse } from "@/lib/http";
import { withdrawProfit, withdrawSchema } from "@/lib/services/profits";
export const POST = secured({ perm: ["profit_payout", "create"] }, async ({ tx, principal, actor, req }) => withdrawProfit(tx, principal, actor, parse(withdrawSchema, await req.json())));
