import { secured, parse } from "@/lib/http";
import { addEntry, entrySchema } from "@/lib/services/projects";
export const POST = secured({ perm: ["expense", "create"] }, async ({ tx, principal, actor, req, params }) => addEntry(tx, principal, actor, params.id!, parse(entrySchema, await req.json())));
