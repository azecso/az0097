import { secured } from "@/lib/http";
import { partnerStatement } from "@/lib/services/settlements";
export const GET = secured({ perm: ["profit_settlement", "view"] }, ({ tx, params }) => partnerStatement(tx, params.id!));
