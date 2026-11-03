import { secured, parse } from "@/lib/http";
import { contactSchema, createContact, listContacts } from "@/lib/services/catalog";
export const GET = secured({ perm: ["contacts", "view"] }, ({ tx, req }) => { const u = new URL(req.url); return listContacts(tx, u.searchParams.get("kind") ?? undefined, u.searchParams.get("archived") === "1"); });
export const POST = secured({ perm: ["contacts", "create"] }, async ({ tx, principal, actor, req }) => createContact(tx, principal, actor, parse(contactSchema, await req.json())));
