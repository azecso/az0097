import { secured } from "@/lib/http";
import { payablesAging } from "@/lib/services/reports";
export const GET = secured({ perm: ["report", "view"] }, ({ tx }) => payablesAging(tx));
