import { secured } from "@/lib/http";
import { reconcile } from "@/lib/services/reconciliation";
export const GET = secured({ ownerOnly: true, perm: ["backup", "view"] }, ({ tx }) => reconcile(tx));
