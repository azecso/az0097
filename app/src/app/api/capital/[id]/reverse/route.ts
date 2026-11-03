import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { reverseCapital } from "@/lib/services/capital";
export const POST = secured({ ownerOnly: true, perm: ["capital", "cancel"] }, async ({ tx, principal, actor, req, params }) => { const b = parse(z.object({ reason: z.string().min(3).max(300), totp: z.string().max(10).nullish() }), await req.json()); return reverseCapital(tx, principal, actor, params.id!, b.reason, b.totp); });
