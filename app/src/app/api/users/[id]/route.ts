import { secured, parse } from "@/lib/http";
import { updateUser, updateUserSchema } from "@/lib/services/users";

export const PATCH = secured({ ownerOnly: true, perm: ["users", "edit_draft"] }, async ({ tx, principal, actor, req, params }) =>
  updateUser(tx, principal, actor, params.id!, parse(updateUserSchema, await req.json())));
