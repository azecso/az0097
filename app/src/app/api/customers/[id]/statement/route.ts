import { secured } from "@/lib/http";
import { customerStatement } from "@/lib/services/reports";
export const GET = secured({ perm: ["contacts", "view"] }, ({ tx, params }) => customerStatement(tx, params.id!));
