import { secured } from "@/lib/http";
export const GET = secured({ perm: ["audit", "view"] }, async ({ tx, req }) => {
  const u = new URL(req.url);
  const limit = Math.min(Number(u.searchParams.get("limit") ?? 100) || 100, 500);
  return tx`SELECT a.id, a.occurred_at AS "occurredAt", u.username AS "user", a.action, a.entity_type AS "entityType",
              a.entity_id AS "entityId", a.before_data AS before, a.after_data AS after, a.reason
            FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ${limit}`;
});
