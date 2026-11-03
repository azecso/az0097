import { secured } from "@/lib/http";
import { journalList } from "@/lib/services/reports";
export const GET = secured({ perm: ["journal", "view"] }, ({ tx }) => journalList(tx));
