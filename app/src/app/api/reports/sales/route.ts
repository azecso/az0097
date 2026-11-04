import { secured, parse } from "@/lib/http";
import { reportQuery, salesReport } from "@/lib/services/analytics";
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => salesReport(tx, parse(reportQuery, Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v)))));
