import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { payDebt } from "@/lib/services/capital";
import { moneyStr } from "@/lib/services/common";
export const POST = secured({ perm: ["personal", "create"] }, async ({ tx, actor, req, params }) => payDebt(tx, actor, params.id!, parse(z.object({ amount: moneyStr }), await req.json()).amount));
