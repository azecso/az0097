// Double-entry posting engine. Every posted document creates ONE balanced entry inside the caller's transaction.
// The database additionally enforces balance (deferred constraint trigger) and immutability.
import Decimal from "decimal.js";
import type { Tx } from "./db";
import type { Actor } from "./audit";
import { d, roundMoney } from "./money";
import { badRequest, conflict } from "./errors";

export interface JLine {
  account: string;                 // account CODE, e.g. "1300"
  debit?: Decimal.Value; credit?: Decimal.Value;   // base currency (IQD), integer-valued after rounding
  currency?: string; amountOrig?: Decimal.Value; fx?: Decimal.Value;
  contactId?: string | null; memo?: string;
}

const yearOf = (date: string) => Number(date.slice(0, 4));

export async function postJournal(tx: Tx, actor: Actor, e: {
  date: string; sourceDocType: string; sourceDocId: string; memo?: string; lines: JLine[]; reversesEntryId?: string;
}): Promise<string> {
  const lines = e.lines.filter((l) => d(l.debit ?? 0).gt(0) || d(l.credit ?? 0).gt(0));
  const debit = lines.reduce((s, l) => s.plus(l.debit ?? 0), d(0)), credit = lines.reduce((s, l) => s.plus(l.credit ?? 0), d(0));
  if (!debit.eq(credit)) throw badRequest("UNBALANCED_ENTRY", `مدين ${debit} ≠ دائن ${credit}`);
  if (lines.length < 2) throw badRequest("ENTRY_NEEDS_TWO_LINES");
  const codes = [...new Set(lines.map((l) => l.account))];
  const accs = await tx`SELECT id, code FROM accounts WHERE code IN ${tx(codes)} AND is_active AND is_postable`;
  const byCode = new Map(accs.map((a) => [a.code as string, a.id as string]));
  for (const c of codes) if (!byCode.has(c)) throw badRequest("ACCOUNT_NOT_FOUND", c);
  const [no] = await tx`SELECT next_document_number(${actor.companyId}, 'journal_entry', ${yearOf(e.date)}) AS n`;
  const [je] = await tx`INSERT INTO journal_entries(company_id, entry_no, entry_date, source_doc_type, source_doc_id, reverses_entry_id, memo, posted_by)
    VALUES (${actor.companyId}, ${no!.n}, ${e.date}, ${e.sourceDocType}, ${e.sourceDocId}, ${e.reversesEntryId ?? null}, ${e.memo ?? null}, ${actor.userId}) RETURNING id`;
  let n = 0;
  for (const l of lines) {
    n += 1;
    const dr = roundMoney(l.debit ?? 0, "IQD"), cr = roundMoney(l.credit ?? 0, "IQD");
    const cur = l.currency ?? "IQD", base = dr.gt(0) ? dr : cr;
    await tx`INSERT INTO journal_lines(company_id, entry_id, line_no, account_id, debit_base, credit_base, currency, amount_orig, fx_rate_snapshot, contact_id, memo)
      VALUES (${actor.companyId}, ${je!.id}, ${n}, ${byCode.get(l.account)!}, ${dr.toString()}, ${cr.toString()}, ${cur},
              ${(l.amountOrig === undefined ? base : d(l.amountOrig)).toString()}, ${(l.fx ?? 1).toString()}, ${l.contactId ?? null}, ${l.memo ?? null})`;
  }
  return je!.id as string;
}

/** Counter-entry: same accounts/amounts/rates with sides swapped, linked by reverses_entry_id (one reversal per entry). */
export async function reverseEntry(tx: Tx, actor: Actor, entryId: string, date: string, memo: string): Promise<string> {
  const [orig] = await tx`SELECT * FROM journal_entries WHERE id = ${entryId}`;
  if (!orig) throw badRequest("ENTRY_NOT_FOUND");
  const already = await tx`SELECT 1 FROM journal_entries WHERE reverses_entry_id = ${entryId}`;
  if (already.length) throw conflict("ALREADY_REVERSED");
  const lines = await tx`SELECT jl.*, a.code FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ${entryId} ORDER BY jl.line_no`;
  return postJournal(tx, actor, { date, sourceDocType: orig.source_doc_type, sourceDocId: orig.source_doc_id, memo, reversesEntryId: entryId,
    lines: lines.map((l) => ({ account: l.code, debit: l.credit_base, credit: l.debit_base, currency: l.currency, amountOrig: l.amount_orig, fx: l.fx_rate_snapshot, contactId: l.contact_id })) });
}
