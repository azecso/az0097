import { secured } from "@/lib/http";
import { receivablesAging } from "@/lib/services/reports";
export const GET = secured({ perm: ["report", "view"] }, ({ tx }) => receivablesAging(tx));
