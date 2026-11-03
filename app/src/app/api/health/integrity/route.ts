import { secured } from "@/lib/http";
import { integrity } from "@/lib/services/integrity";
export const GET = secured({ ownerOnly: true, perm: ["backup", "view"] }, ({ tx }) => integrity(tx));
