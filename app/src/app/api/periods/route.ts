import { secured, parse } from "@/lib/http";
import { closePeriod, listPeriods, periodSchema, reopenPeriod } from "@/lib/services/periods";
export const GET = secured({ perm: ["period_close", "view"] }, ({ tx }) => listPeriods(tx));
export const POST = secured({ ownerOnly: true, perm: ["period_close", "approve"] }, async ({ tx, principal, actor, req }) => closePeriod(tx, principal, actor, parse(periodSchema, await req.json()).month));
export const DELETE = secured({ ownerOnly: true, perm: ["period_close", "cancel"] }, async ({ tx, principal, actor, req }) => { const b = parse(periodSchema, await req.json()); return reopenPeriod(tx, principal, actor, b.month, b.reason ?? "", b.totp); });
