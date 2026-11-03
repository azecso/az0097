import { secured } from "@/lib/http";
import { trialBalance } from "@/lib/services/reports";
export const GET = secured({ perm: ["journal", "view"] }, ({ tx }) => trialBalance(tx));
