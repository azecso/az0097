import { secured } from "@/lib/http";
import { customersSummary } from "@/lib/services/analytics";
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => customersSummary(tx, new URL(req.url).searchParams.get("partyId") || undefined));
