import { secured } from "@/lib/http";
import { postCount } from "@/lib/services/stock-docs";
export const POST = secured({ perm: ["inventory_count", "approve"] }, ({ tx, principal, actor, params }) => postCount(tx, principal, actor, params.id!));
