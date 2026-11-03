import { secured } from "@/lib/http";
import { alerts } from "@/lib/services/dashboard";
export const GET = secured({ perm: ["report", "view"] }, ({ tx }) => alerts(tx));
