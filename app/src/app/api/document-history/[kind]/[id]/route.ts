import { secured } from "@/lib/http";
import { documentHistory } from "@/lib/services/doc-history";
export const GET = secured({ perm: ["audit", "view"] }, ({ tx, params }) => documentHistory(tx, params.kind!, params.id!));
