import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { rejectCapital } from "@/lib/services/capital";
export const POST = secured({ perm: ["capital", "create"] }, async ({ tx, principal, actor, req, params }) => rejectCapital(tx, principal, actor, params.id!, parse(z.object({ reason: z.string().min(3).max(300) }), await req.json()).reason));
