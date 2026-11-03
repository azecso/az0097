import { secured, parse } from "@/lib/http";
import { createPurchase, listPurchases, purchaseSchema } from "@/lib/services/purchases";
export const GET = secured({ perm: ["purchase", "view"] }, ({ tx, req }) => listPurchases(tx, new URL(req.url).searchParams.get("status") ?? undefined));
export const POST = secured({ perm: ["purchase", "create"] }, async ({ tx, principal, actor, req }) => createPurchase(tx, principal, actor, parse(purchaseSchema, await req.json())));
