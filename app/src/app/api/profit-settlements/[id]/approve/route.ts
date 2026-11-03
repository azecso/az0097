import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { approveSettlement } from "@/lib/services/settlements";
export const POST = secured({ ownerOnly: true, perm: ["profit_settlement", "approve"] }, async ({ tx, principal, actor, req, params }) => approveSettlement(tx, principal, actor, params.id!, parse(z.object({ totp: z.string().max(10).nullish() }), await req.json()).totp));
