import type { Tx } from "../db";
import { d } from "../money";
import { inventoryReconciliation, trialBalance } from "./reports";
import { dashboard } from "./dashboard";

/** Owner-facing health: books balance, FIFO == ledger, no negative stock/cash, backups fresh and restore drills passing. */
export async function integrity(tx: Tx) {
  const tb = await trialBalance(tx), rec = await inventoryReconciliation(tx), dash = await dashboard(tx, {});
  const [neg] = await tx`SELECT (SELECT count(*) FROM stock_lots WHERE qty_remaining < 0 OR cost_remaining_base < 0 OR qty_remaining > qty_received)::int AS stock,
      (SELECT count(*) FROM (SELECT ca.id FROM cash_accounts ca JOIN journal_lines jl ON jl.account_id = ca.account_id GROUP BY ca.id HAVING sum(CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) < 0) q)::int AS cash`;
  const [unb] = await tx`SELECT count(*)::int AS n FROM (SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit_base) <> sum(credit_base)) x`;
  const [mig] = await tx`SELECT count(*)::int AS n FROM schema_migrations`.catch(() => [{ n: -1 }] as never);
  const jobs = await tx`SELECT kind, status, started_at AS "startedAt", finished_at AS "finishedAt", size_bytes AS size, error FROM backup_jobs ORDER BY started_at DESC LIMIT 12`.catch(() => []);
  const lastOk = (k: string) => jobs.find((j) => j.kind === k && j.status === "OK");
  const hours = (t: Date | null | undefined) => (t ? Math.floor((Date.now() - new Date(t).getTime()) / 3600000) : null);
  const lastBackup = jobs.find((j) => j.status === "OK" && j.kind !== "RESTORE_TEST"), lastDrill = lastOk("RESTORE_TEST");
  const checks = [
    { code: "TRIAL_BALANCE", ok: tb.balanced, detail: `${tb.totalDebit} / ${tb.totalCredit}` },
    { code: "ENTRIES_BALANCED", ok: unb!.n === 0, detail: String(unb!.n) },
    { code: "INVENTORY_RECONCILED", ok: rec.ok, detail: `رئيسي ${rec.main.diff} • شريك ${rec.partner.diff}` },
    { code: "ACCOUNTING_EQUATION", ok: dash.integrity.balanced, detail: dash.integrity.equationDifference },
    { code: "NO_NEGATIVE_STOCK", ok: neg!.stock === 0, detail: String(neg!.stock) },
    { code: "NO_NEGATIVE_CASH", ok: neg!.cash === 0, detail: String(neg!.cash) },
    { code: "BACKUP_FRESH_26H", ok: hours(lastBackup?.finishedAt) !== null && hours(lastBackup?.finishedAt)! <= 26, detail: lastBackup ? `${hours(lastBackup.finishedAt)} ساعة` : "لا نسخة" },
    { code: "RESTORE_DRILL_35D", ok: hours(lastDrill?.finishedAt) !== null && hours(lastDrill?.finishedAt)! <= 35 * 24, detail: lastDrill ? `${Math.floor(hours(lastDrill.finishedAt)! / 24)} يوم` : "لم يُجرَّ" },
  ];
  return { ok: checks.filter((c) => !c.code.startsWith("BACKUP") && !c.code.startsWith("RESTORE")).every((c) => c.ok), backupsOk: checks.slice(-2).every((c) => c.ok), checks, migrations: mig!.n, jobs, serverTime: new Date().toISOString() };
}
void d;
