import { secured } from "@/lib/http";
import { profitOverview } from "@/lib/services/profits";
export const GET = secured({ perm: ["profit_settlement", "view"] }, ({ tx }) => profitOverview(tx));
