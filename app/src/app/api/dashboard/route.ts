import { secured } from "@/lib/http";
import { dashboard } from "@/lib/services/dashboard";
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => { const u = new URL(req.url); return dashboard(tx, { from: u.searchParams.get("from") ?? undefined, to: u.searchParams.get("to") ?? undefined }); });
