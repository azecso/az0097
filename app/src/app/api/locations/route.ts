import { secured } from "@/lib/http";
import { locations } from "@/lib/services/reports";
export const GET = secured({ perm: ["products", "view"] }, ({ tx }) => locations(tx));
