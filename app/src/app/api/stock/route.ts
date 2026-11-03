import { secured } from "@/lib/http";
import { stockSummary } from "@/lib/services/reports";
export const GET = secured({ perm: ["products", "view"] }, ({ tx }) => stockSummary(tx));
