import { secured, parse } from "@/lib/http";
import { createProject, listProjects, projectSchema } from "@/lib/services/projects";
export const GET = secured({ perm: ["expense", "view"] }, ({ tx }) => listProjects(tx));
export const POST = secured({ perm: ["expense", "create"] }, async ({ tx, principal, actor, req }) => createProject(tx, principal, actor, parse(projectSchema, await req.json())));
