import { secured, parse } from "@/lib/http";
import { createAccountant, createUserSchema, listUsers } from "@/lib/services/users";

export const GET = secured({ ownerOnly: true, perm: ["users", "view"] }, ({ tx }) => listUsers(tx));
export const POST = secured({ ownerOnly: true, perm: ["users", "create"] }, async ({ tx, principal, actor, req }) =>
  createAccountant(tx, principal, actor, parse(createUserSchema, await req.json())));
