import { secured, parse } from "@/lib/http";
import { catalog, getPermissions, setPermissions, setPermsSchema } from "@/lib/services/users";

export const GET = secured({ ownerOnly: true, perm: ["users", "view"] }, async ({ tx, params }) =>
  ({ granted: await getPermissions(tx, params.id!), catalog: await catalog(tx) }));
export const PUT = secured({ ownerOnly: true, perm: ["users", "edit_draft"] }, async ({ tx, principal, actor, req, params }) =>
  setPermissions(tx, principal, actor, params.id!, parse(setPermsSchema, await req.json())));
