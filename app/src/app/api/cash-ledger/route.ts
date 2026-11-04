import { secured, parse } from "@/lib/http";
import { z } from "zod";
import { dateStr, uuid } from "@/lib/services/common";
import { cashLedger } from "@/lib/services/cash-ledger";
const qs = z.object({ accountId: uuid.optional(), from: dateStr.optional(), to: dateStr.optional() });
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx, req }) => cashLedger(tx, parse(qs, Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v)))));
