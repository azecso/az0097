import { secured } from "@/lib/http";
import { partnersOverview } from "@/lib/services/settlements";
export const GET = secured({ perm: ["profit_settlement", "view"] }, ({ tx }) => partnersOverview(tx));
