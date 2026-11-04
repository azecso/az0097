import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { balancesReport } from "@/lib/services/analytics";
const qs = z.object({ side: z.enum(["debtors", "creditors"]), partyId: z.string().uuid().optional(), overdue: z.enum(["1"]).optional(), summary: z.enum(["1"]).optional() });
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => { const q = parse(qs, Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v))); return balancesReport(tx, q.side, { partyId: q.partyId, overdueOnly: q.overdue === "1", summary: q.summary === "1" }); });
