import { secured, parse } from "@/lib/http";
import { previewSettlement, settlementInput } from "@/lib/services/settlements";
export const POST = secured({ perm: ["profit_settlement", "view"] }, async ({ tx, req }) => previewSettlement(tx, parse(settlementInput, await req.json())));
