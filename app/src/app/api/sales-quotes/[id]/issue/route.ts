import { secured } from "@/lib/http";
import { issueQuote } from "@/lib/services/sales";
export const POST = secured({ perm: ["sales", "approve"] }, ({ tx, principal, actor, params }) => issueQuote(tx, principal, actor, params.id!));
