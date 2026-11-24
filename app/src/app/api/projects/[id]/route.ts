import { secured } from "@/lib/http";
import { getProject } from "@/lib/services/projects";
export const GET = secured({ perm: ["expense", "view"] }, ({ tx, params }) => getProject(tx, params.id!));
