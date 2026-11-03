import { secured, parse } from "@/lib/http";
import { createSettlementDraft, listSettlements, settlementInput } from "@/lib/services/settlements";
export const GET = secured({ perm: ["profit_settlement", "view"] }, ({ tx }) => listSettlements(tx));
export const POST = secured({ perm: ["profit_settlement", "create"] }, async ({ tx, principal, actor, req }) => createSettlementDraft(tx, principal, actor, parse(settlementInput, await req.json())));
