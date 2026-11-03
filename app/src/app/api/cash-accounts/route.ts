import { secured } from "@/lib/http";
import { cashAccounts } from "@/lib/services/reports";
export const GET = secured({ perm: ["voucher", "view"] }, ({ tx }) => cashAccounts(tx));
