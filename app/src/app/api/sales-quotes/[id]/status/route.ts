import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { setQuoteStatus } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "approve"] }, async ({ tx, actor, req, params }) => setQuoteStatus(tx, actor, params.id!, parse(z.object({ status: z.enum(["ACCEPTED", "REJECTED", "EXPIRED"]) }), await req.json()).status));
