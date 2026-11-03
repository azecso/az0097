import { secured } from "@/lib/http";
import { inventoryReconciliation } from "@/lib/services/reports";
export const GET = secured({ perm: ["report", "view"] }, ({ tx }) => inventoryReconciliation(tx));
