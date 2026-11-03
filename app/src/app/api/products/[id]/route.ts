import { secured, parse } from "@/lib/http";
import { productUpdateSchema, updateProduct } from "@/lib/services/catalog";
export const PATCH = secured({ perm: ["products", "edit_draft"] }, async ({ tx, principal, actor, req, params }) => updateProduct(tx, principal, actor, params.id!, parse(productUpdateSchema, await req.json())));
