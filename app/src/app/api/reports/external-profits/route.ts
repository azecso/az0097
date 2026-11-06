import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { dateStr, uuid } from "@/lib/services/common";
import { externalProfitReport } from "@/lib/services/analytics";
const qs = z.object({ from: dateStr.optional(), to: dateStr.optional(), partyId: uuid.optional() });
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => externalProfitReport(tx, parse(qs, Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v)))));
