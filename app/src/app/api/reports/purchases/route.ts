import { secured, parse } from "@/lib/http";
import { purchasesReport, reportQuery } from "@/lib/services/analytics";
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => purchasesReport(tx, parse(reportQuery, Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v)))));
