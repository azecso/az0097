import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { dateStr, uuid } from "@/lib/services/common";
import { productMovement } from "@/lib/services/analytics";
const qs = z.object({ productId: uuid, from: dateStr.optional(), to: dateStr.optional() });
export const GET = secured({ perm: ["report", "view"] }, ({ tx, req }) => { const q = parse(qs, Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v))); return productMovement(tx, q.productId, q.from, q.to); });
