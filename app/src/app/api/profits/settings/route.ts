import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { profitStepUpRequired, setProfitStepUp } from "@/lib/services/profits";
import { settingHistory } from "@/lib/services/settings";
export const GET = secured({ perm: ["profit_settlement", "view"] }, async ({ tx }) => ({ profitStepUp: await profitStepUpRequired(tx), history: await settingHistory(tx, "profitStepUp") }));
export const PUT = secured({ perm: ["profit_payout", "create"] }, async ({ tx, principal, actor, req }) => {
  const b = parse(z.object({ profitStepUp: z.boolean(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reason: z.string().max(300).optional() }), await req.json());
  return setProfitStepUp(tx, principal, actor, b.profitStepUp, { effectiveFrom: b.effectiveFrom, reason: b.reason });
});
