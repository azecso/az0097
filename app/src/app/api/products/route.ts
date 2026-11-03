import { secured, parse } from "@/lib/http";
import { createProduct, listProducts, productSchema } from "@/lib/services/catalog";
export const GET = secured({ perm: ["products", "view"] }, ({ tx, req }) => listProducts(tx, new URL(req.url).searchParams.get("archived") === "1"));
export const POST = secured({ perm: ["products", "create"] }, async ({ tx, principal, actor, req }) => createProduct(tx, principal, actor, parse(productSchema, await req.json())));
