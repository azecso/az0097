import Decimal from "decimal.js";
import type { Tx } from "../db";
import { d } from "../money";

/** Where every cash amount came from / went to: one row per cash movement with the source document, its number and the party. */
export const SOURCE_LABEL: Record<string, string> = {
  customer_receipt: "سند قبض من عميل", capital: "رأس مال", purchase_order: "فاتورة شراء نقدية", supplier_payment: "سند صرف لمورد", sales_return: "مرتجع مبيعات",
  purchase_return: "مرتجع مشتريات", expense: "مصروف", expense_payment: "سداد مصروف", payroll_payment: "سداد راتب", personal_advance: "سحب/سداد شخصي",
  profit_payout: "توزيع أرباح", cash_transfer: "تحويل بين الصناديق", opening: "رصيد افتتاحي",
};
const TABLE: Record<string, string> = {
  customer_receipt: "customer_receipts", capital: "capital_transactions", purchase_order: "purchase_orders", supplier_payment: "supplier_payments", sales_return: "sales_returns",
  purchase_return: "purchase_returns", expense: "expenses", expense_payment: "expense_payments", payroll_payment: "payroll_payments", personal_advance: "personal_advances",
  profit_payout: "profit_payouts", cash_transfer: "cash_transfers",
};
export interface LedgerFilter { accountId?: string; from?: string; to?: string }

export async function cashLedger(tx: Tx, f: LedgerFilter = {}) {
  const rows = await tx`
    WITH x AS (
      SELECT cm.id, cm.cash_account_id, cm.amount, cm.amount_base, cm.doc_type, cm.doc_id, cm.moved_at,
             sum(cm.amount) OVER (PARTITION BY cm.cash_account_id ORDER BY cm.moved_at, cm.id) AS balance
      FROM cash_movements cm)
    SELECT x.id, x.moved_at AS "movedAt", ca.id AS "accountId", ca.name AS account, ca.currency, x.amount::text AS amount, x.balance::text AS balance, x.doc_type AS "docType", x.doc_id AS "docId"
    FROM x JOIN cash_accounts ca ON ca.id = x.cash_account_id
    WHERE (${f.accountId ?? null}::uuid IS NULL OR x.cash_account_id = ${f.accountId ?? null}::uuid)
      AND (${f.from ?? null}::date IS NULL OR x.moved_at >= ${f.from ?? null}::date) AND (${f.to ?? null}::date IS NULL OR x.moved_at < (${f.to ?? null}::date + 1))
    ORDER BY x.moved_at DESC, x.id DESC LIMIT 1000`;
  // Resolve document numbers / parties in one query per document type (generic: not every table has every column).
  const byType = new Map<string, string[]>();
  for (const r of rows) byType.set(r.docType as string, [...(byType.get(r.docType as string) ?? []), r.docId as string]);
  const info = new Map<string, { docNo: string | null; party: string | null; note: string | null }>();
  for (const [t, ids] of byType) {
    const table = TABLE[t]; if (!table) continue;
    const recs = await tx`SELECT t.id, COALESCE(to_jsonb(t)->>'doc_no', to_jsonb(t)->>'draft_ref') AS doc_no,
        COALESCE((SELECT c.name FROM contacts c WHERE c.id::text IN (to_jsonb(t)->>'customer_id', to_jsonb(t)->>'supplier_id')),
                 (SELECT p.name FROM partners p WHERE p.id::text = to_jsonb(t)->>'partner_id')) AS party,
        COALESCE(to_jsonb(t)->>'reason', to_jsonb(t)->>'description', to_jsonb(t)->>'notes', to_jsonb(t)->>'note') AS note
      FROM ${tx(table)} t WHERE t.id = ANY(${ids}::uuid[])`;
    for (const r of recs) info.set(`${t}:${r.id}`, { docNo: r.doc_no as string | null, party: r.party as string | null, note: r.note as string | null });
  }
  const out: Record<string, any>[] = (rows as unknown as Record<string, any>[]).map((r) => ({ ...r, source: SOURCE_LABEL[r.docType as string] ?? r.docType, ...(info.get(`${r.docType}:${r.docId}`) ?? { docNo: null, party: null, note: null }) }));
  // Summary by source (per currency): how much came in from where, how much went out where.
  const m = new Map<string, { source: string; currency: string; in: Decimal; out: Decimal }>();
  for (const r of out) {
    const k = `${r.source}|${r.currency}`; const e = m.get(k) ?? { source: r.source as string, currency: r.currency as string, in: d(0), out: d(0) };
    const a = d(r.amount as string); if (a.gt(0)) e.in = e.in.plus(a); else e.out = e.out.plus(a.abs()); m.set(k, e);
  }
  const bySource = [...m.values()].map((e) => ({ source: e.source, currency: e.currency, in: e.in.toString(), out: e.out.toString() })).sort((a, b) => a.source.localeCompare(b.source, "ar"));
  return { rows: out, bySource, truncated: rows.length >= 1000 };
}
