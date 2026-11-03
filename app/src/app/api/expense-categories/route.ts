import { secured, parse } from "@/lib/http";
import { categorySchema, createCategory, listCategories } from "@/lib/services/expenses";
export const GET = secured({ perm: ["expense", "view"] }, ({ tx }) => listCategories(tx));
export const POST = secured({ perm: ["expense", "create"] }, async ({ tx, principal, actor, req }) => createCategory(tx, principal, actor, parse(categorySchema, await req.json())));
