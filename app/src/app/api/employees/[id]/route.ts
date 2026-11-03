import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { setEmployeeActive } from "@/lib/services/expenses";
export const PATCH = secured({ perm: ["payroll", "edit_draft"] }, async ({ tx, actor, req, params }) => setEmployeeActive(tx, actor, params.id!, parse(z.object({ isActive: z.boolean() }), await req.json()).isActive));
