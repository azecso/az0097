import { secured, parse } from "@/lib/http";
import { createDeliveryDraft, deliverySchema, listDeliveries } from "@/lib/services/sales";
export const GET = secured({ perm: ["sales", "view"] }, ({ tx }) => listDeliveries(tx));
export const POST = secured({ perm: ["sales", "create"] }, async ({ tx, principal, actor, req }) => createDeliveryDraft(tx, principal, actor, parse(deliverySchema, await req.json())));
