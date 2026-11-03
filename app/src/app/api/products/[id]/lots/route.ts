import { secured } from "@/lib/http";
import { lotsOf } from "@/lib/services/reports";
export const GET = secured({ perm: ["products", "view"] }, ({ tx, params }) => lotsOf(tx, params.id!));
