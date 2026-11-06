import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { profitStepUpRequired, setProfitStepUp } from "@/lib/services/profits";
export const GET = secured({ perm: ["profit_settlement", "view"] }, async ({ tx }) => ({ profitStepUp: await profitStepUpRequired(tx) }));
export const PUT = secured({ perm: ["profit_payout", "create"] }, async ({ tx, principal, actor, req }) => setProfitStepUp(tx, principal, actor, parse(z.object({ profitStepUp: z.boolean() }), await req.json()).profitStepUp));
