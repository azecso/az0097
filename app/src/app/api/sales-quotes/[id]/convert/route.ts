import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { convertQuote } from "@/lib/services/sales";
import { dateStr, uuid } from "@/lib/services/common";
export const POST = secured({ perm: ["sales", "create"] }, async ({ tx, principal, actor, req, params }) =>
  convertQuote(tx, principal, actor, params.id!, parse(z.object({ saleType: z.enum(["CASH", "CREDIT"]), cashAccountId: uuid.nullish(), docDate: dateStr }), await req.json())));
