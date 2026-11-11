import { secured } from "@/lib/http";
import { checkRate } from "@/lib/services/fx";
export const GET = secured({ perm: ["fx_rate", "view"] }, ({ tx, req }) => { const u = new URL(req.url).searchParams; return checkRate(tx, u.get("currency") ?? "USD", u.get("date") ?? new Date().toISOString().slice(0, 10), u.get("rate") || undefined); });
