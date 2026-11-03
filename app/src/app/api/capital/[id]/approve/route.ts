import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { approveCapital } from "@/lib/services/capital";
export const POST = secured({ ownerOnly: true, perm: ["capital", "approve"] }, async ({ tx, principal, actor, req, params }) => approveCapital(tx, principal, actor, params.id!, parse(z.object({ totp: z.string().max(10).nullish() }), await req.json()).totp));
