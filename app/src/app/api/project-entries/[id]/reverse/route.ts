import { secured, parse } from "@/lib/http";
import { reverseEntryDoc } from "@/lib/services/projects";
import { reverseSchema } from "@/lib/services/purchases";
export const POST = secured({ perm: ["expense", "cancel"] }, async ({ tx, principal, actor, req, params }) => reverseEntryDoc(tx, principal, actor, params.id!, parse(reverseSchema, await req.json()).reason));
