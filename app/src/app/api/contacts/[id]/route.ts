import { secured, parse } from "@/lib/http";
import { contactUpdateSchema, updateContact } from "@/lib/services/catalog";
export const PATCH = secured({ perm: ["contacts", "edit_draft"] }, async ({ tx, actor, req, params }) => updateContact(tx, actor, params.id!, parse(contactUpdateSchema, await req.json())));
