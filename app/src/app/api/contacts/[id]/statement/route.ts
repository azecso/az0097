import { secured } from "@/lib/http";
import { supplierStatement } from "@/lib/services/reports";
export const GET = secured({ perm: ["contacts", "view"] }, ({ tx, params }) => supplierStatement(tx, params.id!));
