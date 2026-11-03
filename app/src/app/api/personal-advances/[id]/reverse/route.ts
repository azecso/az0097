import { secured, parse } from "@/lib/http";
import { reverseAdvance } from "@/lib/services/capital";
import { reverseSchema } from "@/lib/services/sales";
export const POST = secured({ ownerOnly: true, perm: ["personal", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseAdvance(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
