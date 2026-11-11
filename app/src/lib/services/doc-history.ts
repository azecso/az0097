import type { Tx } from "../db";
import { badRequest, notFound } from "../errors";

const KINDS: Record<string, { entity: string; table: string }> = {
  "sales-invoices": { entity: "sales_invoice", table: "sales_invoices" }, "customer-receipts": { entity: "customer_receipt", table: "customer_receipts" },
  purchases: { entity: "purchase_order", table: "purchase_orders" }, "supplier-payments": { entity: "supplier_payment", table: "supplier_payments" }, expenses: { entity: "expense", table: "expenses" },
};
export const HISTORY_KINDS = Object.keys(KINDS);

/** Who did what to a document, and — for invoices — the whole chain of edited versions (original → replacement), including the hidden ones. Read-only. */
export async function documentHistory(tx: Tx, kind: string, id: string) {
  const k = KINDS[kind]; if (!k) throw badRequest("UNKNOWN_KIND");
  const [self] = await tx.unsafe(`SELECT id FROM ${k.table} WHERE id = $1`, [id]); if (!self) throw notFound();
  let chain: Record<string, unknown>[] = [{ id }]; let ids = [id];
  if (kind === "sales-invoices") {
    chain = [...(await tx`WITH RECURSIVE up AS (SELECT id, amended_from FROM sales_invoices WHERE id = ${id} UNION SELECT s.id, s.amended_from FROM sales_invoices s JOIN up ON s.id = up.amended_from),
        down AS (SELECT id, amended_from FROM sales_invoices WHERE id = ${id} UNION SELECT s.id, s.amended_from FROM sales_invoices s JOIN down ON s.amended_from = down.id),
        allv AS (SELECT id FROM up UNION SELECT id FROM down)
      SELECT s.id, s.doc_no AS "docNo", s.status, s.version, s.net::text AS net, s.currency, s.amended_from AS "amendedFrom", s.created_at AS "createdAt", (s.doc_no LIKE '%~r%') AS "replaced" FROM sales_invoices s JOIN allv ON allv.id = s.id ORDER BY s.created_at`)];
    ids = chain.map((c) => c.id as string);
  } else if (kind === "purchases") {
    chain = [...(await tx`WITH RECURSIVE up AS (SELECT id, amended_from FROM purchase_orders WHERE id = ${id} UNION SELECT s.id, s.amended_from FROM purchase_orders s JOIN up ON s.id = up.amended_from),
        down AS (SELECT id, amended_from FROM purchase_orders WHERE id = ${id} UNION SELECT s.id, s.amended_from FROM purchase_orders s JOIN down ON s.amended_from = down.id),
        allv AS (SELECT id FROM up UNION SELECT id FROM down)
      SELECT s.id, s.doc_no AS "docNo", s.status, s.version, s.total::text AS net, s.currency, s.amended_from AS "amendedFrom", s.created_at AS "createdAt", (s.doc_no LIKE '%~r%') AS "replaced" FROM purchase_orders s JOIN allv ON allv.id = s.id ORDER BY s.created_at`)];
    ids = chain.map((c) => c.id as string);
  }
  const events = await tx`SELECT a.id::text AS id, a.occurred_at AS "at", u.username AS "user", a.action, a.entity_id AS "entityId", a.reason, a.before_data AS before, a.after_data AS after
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity_type = ${k.entity} AND a.entity_id = ANY(${ids}::uuid[]) ORDER BY a.id`;
  return { chain, events };
}
