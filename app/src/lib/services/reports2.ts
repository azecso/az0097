import type { Tx } from "../db";
import { badRequest } from "../errors";
import Decimal from "decimal.js";
import { d } from "../money";
import { trialBalance } from "./reports";
import { computeSettlement, partnersOverview } from "./settlements";
import { invoiceProfit } from "./sales";

/**
 * Report registry. Every report is defined ONCE here (title, definition, basis, filters, columns, rows, totals) and the screen, the A4 print/PDF and the Excel export all render this same result,
 * so they cannot disagree. Money stays an exact decimal string until the very last formatting step. Money columns of a row are in the row's `currency` (IQD when absent).
 */
export type Row = Record<string, string | null>;
export interface Col { key: string; label: string; kind?: "text" | "money" | "qty" | "pct"; href?: string; cur?: string }   // cur: this money column is ALWAYS in that currency (e.g. dinar cost beside a dollar invoice)   // href = row key that holds the drill-down link
export interface Filters { from?: string; to?: string; asOf?: string; partyId?: string; account?: string; productId?: string; currency?: string; locationId?: string; side?: string }
export interface Result { columns: Col[]; rows: Row[]; totals: Row[]; notes: string[] }
export interface Def { id: string; title: string; basis: "period" | "asOf" | "snapshot"; definition: string; filters: (keyof Filters)[]; run: (tx: Tx, f: Filters) => Promise<Result> }

const today = () => new Date().toISOString().slice(0, 10);
const Decimal0 = (v: ReturnType<typeof d>) => (v.isNegative() ? d(0) : v);
const S = (v: unknown) => (v === null || v === undefined ? null : String(v));
const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a.plus(r[k] || 0), d(0));
/** Per-currency totals of the given money keys. */
function totalsBy(rows: Row[], keys: string[], label = "الإجمالي"): Row[] {
  const out: Row[] = [];
  for (const cur of [...new Set(rows.map((r) => r.currency ?? "IQD"))].sort()) {
    const rs = rows.filter((r) => (r.currency ?? "IQD") === cur); const t: Row = { [Object.keys(rows[0] ?? {})[0] ?? "label"]: `${label} ${cur}`, currency: cur };
    for (const k of keys) t[k] = sum(rs, k).toString(); out.push(t);
  }
  return out;
}
const DOC_HREF: Record<string, (id: string) => string> = { sales_invoice: (id) => `/sales/${id}`, purchase_order: (id) => `/purchases/${id}`, customer_receipt: (id) => `/print/receipt/${id}` };

// ------------------------------------------------------------------ trial balance (as of)
const trial: Def = { id: "trial-balance", title: "ميزان المراجعة", basis: "asOf", filters: ["asOf"],
  definition: "أرصدة كل حساب في الأستاذ العام حتى تاريخ محدد (قيود مؤرخة حتى ذلك اليوم)، بالدينار. المدين = الدائن دائماً. كل حساب يفتح أستاذه.",
  async run(tx, f) {
    const asOf = f.asOf ?? today(); const t = await trialBalance(tx, asOf);
    const rows: Row[] = t.rows.map((r: any) => ({ code: r.code, name: r.name, type: r.type, debit: r.debit, credit: r.credit, balance: d(r.debit).minus(r.credit).toString(), link: `/reports/ledger?account=${r.code}&to=${asOf}` }));
    return { columns: [{ key: "code", label: "الحساب", href: "link" }, { key: "name", label: "الاسم" }, { key: "debit", label: "مدين", kind: "money" }, { key: "credit", label: "دائن", kind: "money" }, { key: "balance", label: "الرصيد (مدين − دائن)", kind: "money" }],
      rows, totals: [{ code: "الإجمالي", currency: "IQD", debit: t.totalDebit, credit: t.totalCredit, balance: d(t.totalDebit).minus(t.totalCredit).toString() }], notes: [t.balanced ? "✔ متوازن" : "⛔ غير متوازن", `حتى ${asOf}`] };
  } };

// ------------------------------------------------------------------ general ledger of one account
const ledger: Def = { id: "ledger", title: "الأستاذ العام (حساب)", basis: "period", filters: ["account", "from", "to"],
  definition: "حركات حساب واحد بين تاريخين مع الرصيد الافتتاحي والرصيد الجاري. بالدينار (القيمة الأساسية)، وتُعرض العملة الأصلية والمبلغ الأصلي بجانبها. كل سطر يفتح مستنده.",
  async run(tx, f) {
    if (!f.account) throw badRequest("ACCOUNT_REQUIRED", "اختر الحساب");
    const [acc] = await tx`SELECT id, code, name FROM accounts WHERE code = ${f.account}`; if (!acc) throw badRequest("UNKNOWN_ACCOUNT");
    const [o] = await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ${acc.id} AND ${f.from ?? null}::date IS NOT NULL AND je.entry_date < ${f.from ?? null}::date`;
    const ls = await tx`SELECT je.entry_date::text AS date, je.entry_no AS "entryNo", je.source_doc_type AS "docType", je.source_doc_id AS "docId", COALESCE(jl.memo, je.memo) AS memo, jl.currency, jl.amount_orig::text AS orig, jl.debit_base::text AS debit, jl.credit_base::text AS credit
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ${acc.id} AND (${f.from ?? null}::date IS NULL OR je.entry_date >= ${f.from ?? null}::date) AND (${f.to ?? null}::date IS NULL OR je.entry_date <= ${f.to ?? null}::date)
      ORDER BY je.entry_date, je.posted_at, jl.line_no`;
    let bal = d(o!.v); const rows: Row[] = [{ date: f.from ?? "", entryNo: "", docType: "", memo: "رصيد افتتاحي", currency: "IQD", orig: null, debit: null, credit: null, balance: bal.toString(), link: null }];
    let td = d(0), tc = d(0);
    for (const l of ls) { bal = bal.plus(l.debit as string).minus(l.credit as string); td = td.plus(l.debit as string); tc = tc.plus(l.credit as string);
      rows.push({ date: l.date as string, entryNo: l.entryNo as string, docType: l.docType as string, memo: S(l.memo), origCurrency: l.currency as string, orig: d(l.orig as string).toDecimalPlaces(l.currency === "USD" ? 2 : 0).toString(), currency: "IQD", debit: l.debit as string, credit: l.credit as string, balance: bal.toString(), link: DOC_HREF[l.docType as string]?.(l.docId as string) ?? null }); }
    return { columns: [{ key: "date", label: "التاريخ" }, { key: "entryNo", label: "القيد", href: "link" }, { key: "docType", label: "المستند" }, { key: "memo", label: "البيان" }, { key: "origCurrency", label: "عملة المستند" }, { key: "orig", label: "المبلغ الأصلي" }, { key: "debit", label: "مدين", kind: "money" }, { key: "credit", label: "دائن", kind: "money" }, { key: "balance", label: "الرصيد", kind: "money" }],
      rows, totals: [{ date: "الإجمالي", currency: "IQD", debit: td.toString(), credit: tc.toString(), balance: bal.toString() }], notes: [`${acc.code} — ${acc.name}`] };
  } };

// ------------------------------------------------------------------ profit & loss
async function netByAccount(tx: Tx, from: string | undefined, to: string | undefined) {
  return tx`SELECT a.code, a.name, a.type, COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM accounts a
      LEFT JOIN (SELECT l.account_id, l.debit_base, l.credit_base FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                 WHERE (${from ?? null}::date IS NULL OR e.entry_date >= ${from ?? null}::date) AND (${to ?? null}::date IS NULL OR e.entry_date <= ${to ?? null}::date)) jl ON jl.account_id = a.id
    WHERE a.type IN ('REVENUE','COGS','EXPENSE','OTHER') GROUP BY a.code, a.name, a.type HAVING COALESCE(sum(jl.debit_base - jl.credit_base), 0) <> 0 ORDER BY a.code`;
}
const pnl: Def = { id: "profit-loss", title: "الأرباح والخسائر", basis: "period", filters: ["from", "to"],
  definition: "نتيجة النشاط بين تاريخين من الأستاذ العام بالدينار: الإيراد المعترف به (عند التسليم) − الخصومات − المرتجعات − تكلفة البضاعة المسلَّمة − المصاريف ± فروقات الجرد ± فروق الصرف المحققة. كل سطر يفتح أستاذه.",
  async run(tx, f) {
    const accs = await netByAccount(tx, f.from, f.to); const get = (c: string) => d(accs.find((a) => a.code === c)?.v ?? 0);
    const rows: Row[] = []; const link = (c: string) => `/reports/ledger?account=${c}${f.from ? `&from=${f.from}` : ""}${f.to ? `&to=${f.to}` : ""}`;
    const add = (label: string, v: string, code?: string, bold = false) => rows.push({ label, amount: v, currency: "IQD", link: code ? link(code) : null, bold: bold ? "1" : null });
    const sales = get("4100").neg(), disc = get("4150"), ret = get("4190"), netSales = sales.minus(disc).minus(ret), cogs = get("5100"), gross = netSales.minus(cogs);
    add("المبيعات (الإيراد المعترف به قبل الخصم)", sales.toString(), "4100"); add("− الخصومات", disc.neg().toString(), "4150"); add("− المرتجعات", ret.neg().toString(), "4190"); add("= صافي المبيعات", netSales.toString(), undefined, true);
    add("− تكلفة البضاعة المسلَّمة", cogs.neg().toString(), "5100"); add("= الربح التجاري (الإجمالي)", gross.toString(), undefined, true);
    let exp = d(0); for (const a of accs.filter((x) => x.type === "EXPENSE")) { exp = exp.plus(a.v as string); add(`− ${a.name}`, d(a.v as string).neg().toString(), a.code as string); }
    const inv = get("5200"), fx = get("7100").neg();
    if (!inv.isZero()) add("− فروقات الجرد", inv.neg().toString(), "5200"); add("± فروق الصرف المحققة (ربح +/خسارة −)", fx.toString(), "7100");
    const net = gross.minus(exp).minus(inv).plus(fx); add("= صافي نتيجة النشاط", net.toString(), undefined, true);
    return { columns: [{ key: "label", label: "البند", href: "link" }, { key: "amount", label: "المبلغ (IQD)", kind: "money" }], rows, totals: [], notes: ["الإيراد المعترف به = المسلَّم فقط (الفواتير غير المسلَّمة في «إيراد مؤجل»)", "فروق الصرف المحققة تُضاف مرة واحدة ولا تُحتسب مجدداً ضمن المقبوض"] };
  } };

// ------------------------------------------------------------------ balance sheet
const bs: Def = { id: "balance-sheet", title: "المركز المالي", basis: "asOf", filters: ["asOf"],
  definition: "الأصول والالتزامات وحقوق الملكية حتى تاريخ محدد من الأستاذ العام بالدينار. نتيجة النشاط التراكمية حتى التاريخ تظهر ضمن حقوق الملكية. الأصول = الالتزامات + حقوق الملكية.",
  async run(tx, f) {
    const asOf = f.asOf ?? today();
    const accs = await tx`SELECT a.code, a.name, a.type, COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM accounts a
      LEFT JOIN (SELECT l.account_id, l.debit_base, l.credit_base FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.entry_date <= ${asOf}) jl ON jl.account_id = a.id GROUP BY a.code, a.name, a.type ORDER BY a.code`;
    const rows: Row[] = []; let assets = d(0), liab = d(0), eq = d(0), result = d(0);
    const sec = (title: string) => rows.push({ label: title, amount: null, currency: "IQD", link: null, bold: "1" });
    const line = (a: any, sign: 1 | -1) => { const v = d(a.v).mul(sign); if (v.isZero()) return v; rows.push({ label: `${a.code} ${a.name}`, amount: v.toString(), currency: "IQD", link: `/reports/ledger?account=${a.code}&to=${asOf}`, bold: null }); return v; };
    sec("الأصول"); for (const a of accs.filter((x) => x.type === "ASSET")) assets = assets.plus(line(a, 1));
    rows.push({ label: "إجمالي الأصول", amount: assets.toString(), currency: "IQD", link: null, bold: "1" });
    sec("الالتزامات"); for (const a of accs.filter((x) => x.type === "LIABILITY")) liab = liab.plus(line(a, -1));
    rows.push({ label: "إجمالي الالتزامات", amount: liab.toString(), currency: "IQD", link: null, bold: "1" });
    sec("حقوق الملكية"); for (const a of accs.filter((x) => x.type === "EQUITY")) eq = eq.plus(line(a, -1));
    for (const a of accs.filter((x) => ["REVENUE", "COGS", "EXPENSE", "OTHER"].includes(x.type as string))) result = result.minus(a.v as string);
    rows.push({ label: "نتيجة النشاط التراكمية حتى التاريخ", amount: result.toString(), currency: "IQD", link: `/reports/profit-loss?to=${asOf}`, bold: null });
    rows.push({ label: "إجمالي حقوق الملكية", amount: eq.plus(result).toString(), currency: "IQD", link: null, bold: "1" });
    const diff = assets.minus(liab).minus(eq).minus(result);
    return { columns: [{ key: "label", label: "البند", href: "link" }, { key: "amount", label: "المبلغ (IQD)", kind: "money" }], rows, totals: [], notes: [diff.isZero() ? "✔ الأصول = الالتزامات + حقوق الملكية" : `⛔ فرق ${diff}`, `حتى ${asOf}`] };
  } };

// ------------------------------------------------------------------ customer / supplier statements per currency
async function partyRows(tx: Tx, side: "customer" | "supplier", f: Filters) {
  const ar = side === "customer"; const to = f.to ?? today(); const from = f.from ?? null;
  const rows = await tx`
    WITH l AS (
      SELECT jl.contact_id, COALESCE(jl.currency, 'IQD') AS cur, a.code, je.entry_date AS dt, je.source_doc_type AS st,
        COALESCE(cr.kind, '') AS rkind, COALESCE(cr.usd_settlement, false) AS usd, COALESCE(jl.memo, ol.memo, '') AS lm,
        (CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) AS signed
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
        LEFT JOIN journal_entries oe ON oe.id = je.reverses_entry_id LEFT JOIN journal_lines ol ON ol.entry_id = oe.id AND ol.line_no = jl.line_no
        LEFT JOIN customer_receipts cr ON cr.id = je.source_doc_id AND je.source_doc_type = 'customer_receipt'
      WHERE a.code = ANY(${ar ? ["1200", "2400"] : ["2100"]}::text[]) AND jl.contact_id IS NOT NULL AND je.entry_date <= ${to}
        AND (${f.partyId ?? null}::uuid IS NULL OR jl.contact_id = ${f.partyId ?? null}::uuid) AND (${f.currency ?? null}::text IS NULL OR COALESCE(jl.currency, 'IQD') = ${f.currency ?? null}))
    SELECT c.id AS pid, c.name, l.cur,
      COALESCE(sum(signed) FILTER (WHERE l.code = ${ar ? "1200" : "2100"} AND ${from}::date IS NOT NULL AND dt < ${from}::date), 0)::text AS opening_raw,
      COALESCE(sum(signed) FILTER (WHERE l.code = ${ar ? "1200" : "2100"} AND st = 'opening' AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS opening_docs,
      COALESCE(sum(signed) FILTER (WHERE l.code = ${ar ? "1200" : "2100"} AND st = ${ar ? "sales_invoice" : "purchase_order"} AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS invoices,
      COALESCE(sum(signed) FILTER (WHERE l.code = ${ar ? "1200" : "2100"} AND st = ${ar ? "sales_return" : "purchase_return"} AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS returns,
      COALESCE(sum(signed) FILTER (WHERE l.code = ${ar ? "1200" : "2100"} AND st = ${ar ? "customer_receipt" : "supplier_payment"} AND rkind <> 'CREDIT_APPLICATION' AND NOT usd AND lm <> 'ربح موزَّع خارج النظام' AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS cash,
      COALESCE(sum(signed) FILTER (WHERE l.code = '1200' AND st = 'customer_receipt' AND usd AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS usd_eq,
      COALESCE(sum(signed) FILTER (WHERE l.code = '1200' AND st = 'customer_receipt' AND lm = 'ربح موزَّع خارج النظام' AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS external,
      COALESCE(sum(signed) FILTER (WHERE l.code = '1200' AND st = 'customer_receipt' AND rkind = 'CREDIT_APPLICATION' AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS applied,
      COALESCE(sum(signed) FILTER (WHERE l.code = ${ar ? "1200" : "2100"}), 0)::text AS closing_raw,
      COALESCE(sum(signed) FILTER (WHERE l.code = '2400' AND st = 'sales_return' AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS credit_returns,
      COALESCE(sum(signed) FILTER (WHERE l.code = '2400' AND st = 'customer_receipt' AND rkind <> 'CREDIT_APPLICATION' AND (${from}::date IS NULL OR dt >= ${from}::date)), 0)::text AS credit_advance,
      COALESCE(sum(signed) FILTER (WHERE l.code = '2400'), 0)::text AS credit_closing_raw
    FROM l JOIN contacts c ON c.id = l.contact_id GROUP BY c.id, c.name, l.cur ORDER BY c.name, c.id, l.cur`;
  return rows;
}
function statement(side: "customer" | "supplier"): Def {
  const ar = side === "customer";
  return { id: ar ? "customers" : "suppliers", title: ar ? "كشف حسابات العملاء" : "كشف حسابات الموردين", basis: "period", filters: ["from", "to", "partyId", "currency"],
    definition: ar ? "لكل عميل ولكل عملة (دون دمج عملتين ولا عميلين بالاسم نفسه): الرصيد الافتتاحي، الفواتير، المرتجعات، المقبوض النقدي الفعلي، التسويات غير النقدية (ربح موزَّع خارج النظام)، تسوية الرصيد الدائن، والرصيد الختامي. الرصيد الدائن (2400) مفصول: ما نشأ عن مرتجع وما نشأ عن دفعة غير مخصَّصة. المصدر: الأستاذ 1200/2400، قطع بتاريخ «إلى»."
      : "لكل مورد ولكل عملة: الرصيد الافتتاحي، الفواتير، المرتجعات، المدفوع الفعلي، أخرى، والرصيد الختامي (سالب = دفعة مقدمة للمورد). المصدر: الأستاذ 2100، قطع بتاريخ «إلى».",
    async run(tx, f) {
      const raw = await partyRows(tx, side, f); const usdRecv = new Map<string, string>();
      if (ar) for (const u of await tx`SELECT customer_id::text AS cid, COALESCE(sum(amount), 0)::text AS s FROM customer_receipts WHERE usd_settlement AND status = 'POSTED' AND doc_date <= ${f.to ?? today()} AND (${f.from ?? null}::date IS NULL OR doc_date >= ${f.from ?? null}::date) GROUP BY customer_id`) usdRecv.set(u.cid as string, u.s as string);
      const neg = (v: string) => d(v).neg();
      const rows: Row[] = raw.filter((r) => ar || !d(r.closing_raw as string).isZero() || !d(r.invoices as string).isZero() || !d(r.opening_raw as string).isZero()).map((r) => {
        const sg = ar ? 1 : -1;                                                 // receivable: debit positive; payable: credit positive
        const opening = d(r.opening_raw as string).mul(sg), opd = d(r.opening_docs as string).mul(sg), inv = d(r.invoices as string).mul(sg), ret = neg(r.returns as string).mul(sg), cash = neg(r.cash as string).mul(sg);
        const ext = neg(r.external as string), app = neg(r.applied as string), usdEq = neg(r.usd_eq as string), closing = d(r.closing_raw as string).mul(sg);
        const other = opening.plus(opd).plus(inv).minus(ret).minus(cash).minus(ar ? ext.plus(app).plus(usdEq) : 0).minus(closing).neg();   // anything not classified above (reversal timing etc.) so the row always foots
        const base: Row = { party: r.name as string, partyId: r.pid as string, currency: r.cur as string, opening: opening.toString(), openingDocs: opd.toString(), invoices: inv.toString(), returns: ret.toString(), cash: cash.toString() };
        if (ar) Object.assign(base, { external: ext.toString(), applied: app.toString(), usdEq: usdEq.toString(), usdReceived: r.cur === "IQD" ? usdRecv.get(`${r.pid}`) ?? "0" : "0" });
        Object.assign(base, { other: other.toString(), closing: closing.toString() });
        if (ar) Object.assign(base, { creditReturns: neg(r.credit_returns as string).toString(), creditAdvance: neg(r.credit_advance as string).toString(), creditClosing: neg(r.credit_closing_raw as string).toString() });
        return base;
      });
      const cols: Col[] = [{ key: "party", label: ar ? "العميل" : "المورد" }, { key: "currency", label: "العملة" }, { key: "opening", label: "رصيد افتتاحي", kind: "money" }, { key: "openingDocs", label: "أرصدة افتتاحية مُدخلة", kind: "money" }, { key: "invoices", label: "الفواتير", kind: "money" }, { key: "returns", label: "المرتجعات", kind: "money" }, { key: "cash", label: ar ? "المقبوض نقداً (فعلي)" : "المدفوع (فعلي)", kind: "money" }];
      if (ar) cols.push({ key: "external", label: "تسوية غير نقدية (ربح خارجي)", kind: "money" }, { key: "applied", label: "رصيد دائن مُسوّى", kind: "money" }, { key: "usdEq", label: "معادل تسديد بقبض دولار (محتسب، ليس نقد دينار)", kind: "money" }, { key: "usdReceived", label: "دولار مقبوض فعلياً (USD)", kind: "money", cur: "USD" });
      cols.push({ key: "other", label: "أخرى", kind: "money" }, { key: "closing", label: ar ? "الرصيد الختامي (مدين)" : "الرصيد الختامي (دائن)", kind: "money" });
      if (ar) cols.push({ key: "creditReturns", label: "رصيد دائن من مرتجع", kind: "money" }, { key: "creditAdvance", label: "رصيد دائن من دفعة غير مخصَّصة", kind: "money" }, { key: "creditClosing", label: "رصيد دائن ختامي", kind: "money" });
      const keys = cols.filter((c) => c.kind === "money").map((c) => c.key);
      return { columns: cols, rows, totals: totalsBy(rows, keys), notes: ["لا يُجمع الدولار مع الدينار: لكل عملة سطر إجمالي مستقل", "المقبوض النقدي = سندات القبض النقدية الفعلية فقط؛ لا يُشتق من صافي المبيعات"] };
    } };
}

// ------------------------------------------------------------------ customer invoices in detail: every invoice, what was paid and every movement on it
const customerInvoices: Def = { id: "customer-invoices", title: "فواتير العملاء التفصيلية — المسدَّد والمتبقي وكل حركة", basis: "period", filters: ["from", "to", "partyId", "currency"],
  definition: "لكل عميل: كل فاتورة بيع فعّالة (الملغاة والمستبدلة لا تظهر) بتاريخها وإجماليها والمسدَّد منها والمرتجع والمتبقي، وتحت كل فاتورة كل حركة جرت عليها بتاريخها: سندات القبض (نقدي/تسوية رصيد دائن/مستلم خارج الصندوق) والمرتجعات، مع الرصيد المتبقي بعد كل حركة. السندات الملغاة تُعرض بوضوح ولا تدخل في المسدَّد. «من/إلى»: تاريخ الفاتورة (أولاً) والمسدَّد يُحسب حتى تاريخ «إلى». لكل عملة إجمالي مستقل ولا يُجمع الدولار مع الدينار. المصدر: الفواتير وسندات القبض والمرتجعات نفسها، ويطابق كشف الحساب.",
  async run(tx, f) {
    const to = f.to ?? today(), from = f.from ?? null, party = f.partyId ?? null, cur = f.currency ?? null;
    const invs = await tx`SELECT si.id, si.doc_no, si.doc_date::text AS dt, si.currency, si.net::text AS net, c.name AS customer, c.id AS cid, si.sale_type FROM sales_invoices si JOIN contacts c ON c.id = si.customer_id
      WHERE si.status = 'POSTED' AND si.doc_date <= ${to} AND (${from}::date IS NULL OR si.doc_date >= ${from}::date) AND (${party}::uuid IS NULL OR si.customer_id = ${party}::uuid) AND (${cur}::text IS NULL OR si.currency = ${cur}::text)
      ORDER BY c.name, c.id, si.doc_date, si.doc_no`;
    const ids = invs.map((i) => i.id as string);
    const rcs = ids.length ? await tx`SELECT a.invoice_id, r.id, r.doc_no, r.doc_date::text AS dt, r.status, r.kind, r.created_at, ca.name AS acct, a.external, a.external_kind, a.amount::text AS amount, r.auto_for_invoice_id IS NOT NULL AS auto, r.usd_settlement AS usd, r.amount::text AS usd_amount, r.settlement_rate::text AS srate, r.remaining_after::text AS rem_after
      FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id LEFT JOIN cash_accounts ca ON ca.id = r.cash_account_id
      WHERE a.invoice_id = ANY(${ids}::uuid[]) AND r.status IN ('POSTED','REVERSED') AND r.doc_date <= ${to} ORDER BY r.doc_date, r.created_at` : [];
    const rets = ids.length ? await tx`SELECT sr.invoice_id, sr.id, sr.doc_no, sr.doc_date::text AS dt, sr.status, sr.created_at, sr.value_orig::text AS value, sr.applied_orig::text AS applied, sr.credit_orig::text AS credit, sr.refund_orig::text AS refund
      FROM sales_returns sr WHERE sr.invoice_id = ANY(${ids}::uuid[]) AND sr.status IN ('POSTED','REVERSED') AND sr.doc_date <= ${to} ORDER BY sr.doc_date, sr.created_at` : [];
    const rows: Row[] = [];
    for (const i of invs) {
      type Mv = { dt: string; at: number; kind: string; no: string; link: string | null; note: string; amount: string; effect: ReturnType<typeof d>; paid: ReturnType<typeof d>; ret: ReturnType<typeof d>; void: boolean };
      const mv: Mv[] = [];
      for (const a of rcs.filter((x) => x.invoice_id === i.id)) {
        const live = a.status === "POSTED", amt = d(a.amount as string);
        const kind = a.usd ? "قبض دولار مقابل فاتورة دينار (معادل التسديد محتسب)" : a.kind === "CREDIT_APPLICATION" ? "تسوية من رصيد دائن" : a.external ? (a.external_kind === "OUTSIDE_MARGIN" ? "مستلم خارج الصندوق (ربح خارج التوزيع)" : "تسوية غير نقدية (ربح موزَّع خارج النظام)") : a.auto ? "قبض نقدي (بيع نقدي)" : "قبض نقدي";
        mv.push({ dt: a.dt as string, at: new Date(a.created_at as string).getTime(), kind: live ? kind : `${kind} — ملغى`, no: a.doc_no as string, link: `/print/receipt/${a.id}`, note: a.usd ? `${a.acct ?? ""} — ${d(a.usd_amount as string)} USD مقبوض فعلياً، المعادل المحتسب ${amt} د.ع (سعر مستنتج ${d(a.srate as string)})، المتبقي بعده ${d(a.rem_after as string)} د.ع` : (a.acct as string | null) ?? "", amount: amt.toString(), effect: live ? amt : d(0), paid: live ? amt : d(0), ret: d(0), void: !live });
      }
      for (const r of rets.filter((x) => x.invoice_id === i.id)) {
        const live = r.status === "POSTED", ap = d(r.applied as string);
        const parts = [d(r.credit as string).gt(0) ? `رصيد دائن ${d(r.credit as string)}` : "", d(r.refund as string).gt(0) ? `مُسترد نقداً ${d(r.refund as string)}` : ""].filter(Boolean).join(" · ");
        mv.push({ dt: r.dt as string, at: new Date(r.created_at as string).getTime(), kind: live ? "مرتجع" : "مرتجع — ملغى", no: r.doc_no as string, link: `/sales/${i.id}`, note: parts, amount: d(r.value as string).toString(), effect: live ? ap : d(0), paid: d(0), ret: live ? ap : d(0), void: !live });
      }
      mv.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : a.at - b.at));
      const net = d(i.net as string), paid = mv.reduce((t, m) => t.plus(m.paid), d(0)), ret = mv.reduce((t, m) => t.plus(m.ret), d(0));
      const base = { customer: i.customer as string, invoiceNo: i.doc_no as string, invoiceLink: `/sales/${i.id}`, currency: i.currency as string };
      rows.push({ ...base, invoiceDate: i.dt as string, type: i.sale_type === "CASH" ? "فاتورة بيع نقدي" : "فاتورة بيع آجل", docNo: i.doc_no as string, docLink: `/sales/${i.id}`, docDate: i.dt as string, note: "", amount: null, invoiceTotal: net.toString(), paid: paid.toString(), returns: ret.toString(), remaining: net.minus(paid).minus(ret).toString(), balance: net.toString() });
      let run = net;
      for (const m of mv) { run = run.minus(m.effect); rows.push({ ...base, invoiceDate: null, type: m.kind, docNo: m.no, docLink: m.link, docDate: m.dt, note: m.note, amount: m.amount, invoiceTotal: null, paid: null, returns: null, remaining: null, balance: m.void ? null : run.toString() }); }
    }
    const cols: Col[] = [{ key: "customer", label: "العميل" }, { key: "invoiceNo", label: "الفاتورة", href: "invoiceLink" }, { key: "invoiceDate", label: "تاريخ الفاتورة" }, { key: "type", label: "الحركة" }, { key: "docNo", label: "رقم المستند", href: "docLink" }, { key: "docDate", label: "تاريخ الحركة" }, { key: "note", label: "الصندوق / ملاحظة" },
      { key: "amount", label: "مبلغ الحركة", kind: "money" }, { key: "invoiceTotal", label: "إجمالي الفاتورة", kind: "money" }, { key: "paid", label: "المسدَّد", kind: "money" }, { key: "returns", label: "المرتجع", kind: "money" }, { key: "remaining", label: "المتبقي", kind: "money" }, { key: "balance", label: "المتبقي بعد الحركة", kind: "money" }];
    return { columns: cols, rows, totals: totalsBy(rows, ["invoiceTotal", "paid", "returns", "remaining"]), notes: ["سطر الفاتورة هو الأول، وتحته حركاتها بالتاريخ؛ الإجمالي يجمع سطور الفواتير فقط فلا يتكرر شيء", "الدولار والدينار لا يُجمعان: إجمالي مستقل لكل عملة"] };
  } };

// ------------------------------------------------------------------ inventory movement
const inventory: Def = { id: "inventory-movement", title: "حركة المخزون", basis: "period", filters: ["from", "to", "productId", "locationId"],
  definition: "لكل مادة وموقع: الرصيد الافتتاحي قبل «من»، الوارد (شراء/افتتاحي)، الصادر (بيع)، مرتجع المبيعات، مرتجع المشتريات، التحويلات، الجرد، والختامي — بالكمية (بوحدة المادة الأساسية) والقيمة بالدينار. لا تُجمع الكميات عبر وحدات مختلفة. المصدر: حركات المخزون المؤرخة بتاريخ المستند.",
  async run(tx, f) {
    const from = f.from ?? null, to = f.to ?? today();
    const mv = await tx`SELECT p.id AS pid, p.code, p.name, p.base_uom AS uom, sl.id AS lid, sl.name AS loc,
        COALESCE(sum(m.qty_base) FILTER (WHERE ${from}::date IS NOT NULL AND m.moved_at < ${from}::date), 0)::text AS oq, COALESCE(sum(m.cost_base) FILTER (WHERE ${from}::date IS NOT NULL AND m.moved_at < ${from}::date), 0)::text AS ov,
        COALESCE(sum(m.qty_base) FILTER (WHERE m.movement_type IN ('PURCHASE_IN','OPENING') AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS inq, COALESCE(sum(m.cost_base) FILTER (WHERE m.movement_type IN ('PURCHASE_IN','OPENING') AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS inv,
        COALESCE(sum(m.qty_base) FILTER (WHERE m.movement_type = 'SALE_OUT' AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS outq, COALESCE(sum(m.cost_base) FILTER (WHERE m.movement_type = 'SALE_OUT' AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS outv,
        COALESCE(sum(m.qty_base) FILTER (WHERE m.movement_type = 'SALE_RETURN_IN' AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS srq, COALESCE(sum(m.cost_base) FILTER (WHERE m.movement_type = 'SALE_RETURN_IN' AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS srv,
        COALESCE(sum(m.qty_base) FILTER (WHERE m.movement_type = 'PURCHASE_RETURN_OUT' AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS prq, COALESCE(sum(m.cost_base) FILTER (WHERE m.movement_type = 'PURCHASE_RETURN_OUT' AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS prv,
        COALESCE(sum(m.qty_base) FILTER (WHERE m.movement_type IN ('TRANSFER_IN','TRANSFER_OUT') AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS trq, COALESCE(sum(m.cost_base) FILTER (WHERE m.movement_type IN ('TRANSFER_IN','TRANSFER_OUT') AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS trv,
        COALESCE(sum(m.qty_base) FILTER (WHERE m.movement_type IN ('COUNT_ADJ','REVERSAL') AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS adq, COALESCE(sum(m.cost_base) FILTER (WHERE m.movement_type IN ('COUNT_ADJ','REVERSAL') AND (${from}::date IS NULL OR m.moved_at >= ${from}::date)), 0)::text AS adv,
        COALESCE(sum(m.qty_base), 0)::text AS cq, COALESCE(sum(m.cost_base), 0)::text AS cv
      FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN stock_locations sl ON sl.id = m.location_id
      WHERE m.moved_at < (${to}::date + 1) AND (${f.productId ?? null}::uuid IS NULL OR m.product_id = ${f.productId ?? null}::uuid) AND (${f.locationId ?? null}::uuid IS NULL OR m.location_id = ${f.locationId ?? null}::uuid)
      GROUP BY p.id, p.code, p.name, p.base_uom, sl.id, sl.name ORDER BY p.code, sl.name`;
    const rows: Row[] = mv.map((r) => ({ product: `${r.code} — ${r.name}`, location: r.loc as string, uom: r.uom as string, currency: "IQD", oq: r.oq as string, inq: r.inq as string, outq: d(r.outq as string).abs().toString(), srq: r.srq as string, prq: d(r.prq as string).abs().toString(), trq: r.trq as string, adq: r.adq as string, cq: r.cq as string, cv: r.cv as string, ov: r.ov as string, outv: d(r.outv as string).abs().toString() }));
    // value reconciliation with the ledger (1300 + 1310) as of the end date
    const [gl] = await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id WHERE a.code IN ('1300','1310') AND je.entry_date <= ${to}`;
    const all = sum(rows.map((r) => ({ v: r.cv })) as Row[], "v"), scoped = !f.productId && !f.locationId;
    return { columns: [{ key: "product", label: "المادة" }, { key: "location", label: "الموقع" }, { key: "uom", label: "الوحدة" }, { key: "oq", label: "افتتاحي (كمية)", kind: "qty" }, { key: "inq", label: "وارد", kind: "qty" }, { key: "outq", label: "صادر", kind: "qty" }, { key: "srq", label: "مرتجع مبيعات", kind: "qty" }, { key: "prq", label: "مرتجع مشتريات", kind: "qty" }, { key: "trq", label: "تحويل (صافي)", kind: "qty" }, { key: "adq", label: "جرد/تعديل", kind: "qty" }, { key: "cq", label: "ختامي (كمية)", kind: "qty" }, { key: "cv", label: "ختامي (قيمة IQD)", kind: "money" }],
      rows, totals: [{ product: "إجمالي القيمة", currency: "IQD", cv: all.toString() }], notes: [scoped ? (all.eq(gl!.v as string) ? `✔ القيمة الختامية = الأستاذ (1300+1310) = ${gl!.v}` : `⛔ القيمة ${all} ≠ الأستاذ ${gl!.v}`) : "المطابقة مع الأستاذ تُعرض عند عدم تحديد مادة أو موقع", "الكميات بوحدة المادة الأساسية؛ لا يوجد مجموع كميات عبر مواد"] };
  } };

// ------------------------------------------------------------------ cash & custody
const CASH_DOC: Record<string, string> = { customer_receipt: "قبض من عميل", supplier_payment: "دفع لمورد", cash_transfer: "تحويل بين الصناديق", expense: "مصروف", expense_payment: "سداد مصروف", payroll_payment: "راتب", capital: "رأس مال / سحب", opening: "رصيد افتتاحي", profit_payout: "دفعة أرباح", sales_return: "رد نقدي لعميل", purchase_return: "رد نقدي من مورد", purchase_order: "شراء نقدي", sales_invoice: "بيع نقدي", personal_advance: "سلفة/سحب شخصي", capital_withdrawal: "سحب رأس مال" };
const cashMv: Def = { id: "cash-movement", title: "حركة النقد والعهدة", basis: "period", filters: ["from", "to", "currency"],
  definition: "لكل صندوق/مصرف/عهدة (وكل عملة على حدة): الرصيد الافتتاحي، الداخل والخارج حسب نوع الحركة (قبض، دفع، تحويل، رأس مال، …) والرصيد الختامي بعملة الحساب. التحويل بين الصناديق ليس قبضاً. المصدر: قيود الأستاذ العام لحساب كل صندوق (بتاريخ القيد)؛ وتُطابَق مع سجل حركة النقد في «مطابقة الدفاتر».",
  async run(tx, f) {
    const from = f.from ?? null, to = f.to ?? today();
    const mv = await tx`SELECT ca.id, ca.name, ca.currency, ca.kind, je.source_doc_type AS dt,
        COALESCE(sum(CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) FILTER (WHERE ${from}::date IS NOT NULL AND je.entry_date < ${from}::date), 0)::text AS opening,
        COALESCE(sum(jl.amount_orig) FILTER (WHERE jl.debit_base > 0 AND (${from}::date IS NULL OR je.entry_date >= ${from}::date) AND je.entry_date <= ${to}), 0)::text AS inflow,
        COALESCE(sum(jl.amount_orig) FILTER (WHERE jl.credit_base > 0 AND (${from}::date IS NULL OR je.entry_date >= ${from}::date) AND je.entry_date <= ${to}), 0)::text AS outflow
      FROM cash_accounts ca LEFT JOIN (journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id) ON jl.account_id = ca.account_id AND je.entry_date <= ${to}
      WHERE (${f.currency ?? null}::text IS NULL OR ca.currency = ${f.currency ?? null}) GROUP BY ca.id, ca.name, ca.currency, ca.kind, je.source_doc_type ORDER BY ca.name, je.source_doc_type`;
    const accs = new Map<string, { name: string; currency: string; opening: ReturnType<typeof d>; rows: Row[] }>();
    for (const r of mv) { const a = accs.get(r.id as string) ?? { name: r.name as string, currency: r.currency as string, opening: d(0), rows: [] }; a.opening = a.opening.plus(r.opening as string); if (r.dt && (!d(r.inflow as string).isZero() || !d(r.outflow as string).isZero())) a.rows.push({ type: CASH_DOC[r.dt as string] ?? (r.dt as string), inflow: r.inflow as string, outflow: r.outflow as string }); accs.set(r.id as string, a); }
    const rows: Row[] = []; const kindOf = new Map(mv.map((r) => [r.id as string, r.kind as string]));
    for (const [id, a] of accs) {
      rows.push({ account: a.name, currency: a.currency, type: "رصيد افتتاحي", inflow: null, outflow: null, balance: a.opening.toString() });
      let bal = a.opening; for (const x of a.rows) { bal = bal.plus(x.inflow!).minus(x.outflow!); rows.push({ account: a.name, currency: a.currency, type: x.type ?? null, inflow: x.inflow ?? null, outflow: x.outflow ?? null, balance: null }); }
      rows.push({ account: a.name, currency: a.currency, type: kindOf.get(id) === "PARTNER_CUSTODY" ? "رصيد ختامي (عهدة — لا يُحتسب ضمن النقد المتاح)" : "رصيد ختامي", inflow: null, outflow: null, balance: bal.toString() });
    }
    return { columns: [{ key: "account", label: "الحساب" }, { key: "currency", label: "العملة" }, { key: "type", label: "الحركة" }, { key: "inflow", label: "داخل", kind: "money" }, { key: "outflow", label: "خارج", kind: "money" }, { key: "balance", label: "الرصيد", kind: "money" }], rows, totals: [], notes: ["كل صندوق بعملته؛ لا جمع بين العملات", "التحويل بين الصندوق والعهدة حركة داخلية وليست قبضاً ثانياً"] };
  } };


// ------------------------------------------------------------------ profits: accounting vs eligible vs payable, per partner
const profits: Def = { id: "profit-statement", title: "كشف الأرباح والشركاء", basis: "snapshot", filters: ["from", "to"],
  definition: "ثلاثة مقاييس منفصلة بالدينار: (1) الربح المحاسبي للفترة من الأستاذ؛ (2) الربح المؤهل للتوزيع (فواتير مسدَّدة ومسلَّمة بالكامل فقط) بعد المصاريف والخسائر المرحَّلة والحجز؛ (3) السيولة القابلة للدفع. ثم لكل طرف: المعتمد والمدفوع والمتبقي. المصدر: الأستاذ + التسويات المعتمدة، ويعرض الوضع الحالي (حتى اليوم).",
  async run(tx, f) {
    const p = await pnl.run(tx, { from: f.from, to: f.to }); const pick = (l: string) => p.rows.find((x) => x.label === l)?.amount ?? "0";
    const [last] = await tx`SELECT period_end::text AS pe FROM profit_settlements WHERE status = 'POSTED' ORDER BY period_end DESC LIMIT 1`;
    const start = last ? new Date(Date.parse(last.pe as string) + 86400000).toISOString().slice(0, 10) : "2000-01-01";
    const live = await computeSettlement(tx, { periodStart: start, periodEnd: today(), reserved: "0", releaseReserve: "0", adjustments: "0" });
    const ov = await partnersOverview(tx);
    const paidBy = new Map((await tx`SELECT p.id, COALESCE(sum(po.amount) FILTER (WHERE po.status = 'POSTED'), 0)::text AS paid, COALESCE((SELECT sum(sh.share_amount) FROM profit_settlement_shares sh JOIN profit_settlements s ON s.id = sh.settlement_id WHERE sh.partner_id = p.id AND s.status = 'POSTED'), 0)::text AS approved FROM partners p LEFT JOIN profit_payouts po ON po.partner_id = p.id GROUP BY p.id`).map((r) => [r.id as string, r]));
    const rows: Row[] = []; const add = (label: string, v: string | null, grp = false) => rows.push({ label, amount: v, currency: "IQD", bold: grp ? "1" : null });
    add("1) الربح المحاسبي (الفترة المحددة)", null, true); add("الربح التجاري (إيراد معترف به − تكلفة المسلَّم − مرتجعات)", pick("= الربح التجاري (الإجمالي)")); add("± فروق الصرف المحققة", pick("± فروق الصرف المحققة (ربح +/خسارة −)")); add("صافي نتيجة النشاط (بعد المصاريف)", pick("= صافي نتيجة النشاط"));
    const usedIds = await tx`SELECT DISTINCT invoice_id FROM sales_lines WHERE profit_class = 'USED'`; let used = d(0);
    for (const r of usedIds) used = used.plus((await invoiceProfit(tx, r.invoice_id as string)).usedProfitBase);
    add("منه: ربح المستعمل (مستبعد من الشراكة، يبقى في الحسابات)", used.toString());
    add("2) الربح المؤهل للتوزيع (حتى اليوم، منذ آخر تسوية معتمدة)", null, true); add("ربح مؤهل جديد (فواتير مسدَّدة ومسلَّمة بالكامل)", live.eligibleProfit); add("ربح غير مؤهل بعد (لم تُسدَّد أو تُسلَّم بالكامل)", live.pendingProfit);
    add("− مصاريف وبنود مستحقة منذ آخر تسوية", live.deductions); add("خسارة مرحَّلة سابقة", live.lossCarriedIn); add("رصيد الحجز", live.reserveBefore); add("= القابل للتوزيع الآن (قبل أي حجز جديد)", live.distributable, true);
    add("3) السيولة القابلة للدفع (دينار)", ov.liquidity.available, true);
    add("4) الشركاء", null, true);
    for (const x of ov.partners as unknown as { id: string; name: string }[]) { const pb = paidBy.get(x.id as string); add(`${x.name} — معتمد`, pb ? (pb.approved as string) : "0"); add(`${x.name} — مدفوع`, pb ? (pb.paid as string) : "0"); add(`${x.name} — متبقٍّ`, d(pb?.approved as string ?? 0).minus(pb?.paid as string ?? 0).toString()); }
    return { columns: [{ key: "label", label: "البند" }, { key: "amount", label: "المبلغ (IQD)", kind: "money" }], rows, totals: [], notes: ["كل المبالغ بالدينار العراقي؛ الصرف بالدينار فقط", "الربح المحاسبي ≠ الربح المؤهل ≠ السيولة: ثلاثة مقاييس مستقلة"] };
  } };

// ------------------------------------------------------------------ profit-outside-distribution goods: batches and their sales, linked by real lot/line/receipt links
const ROOT_LOTS = `WITH RECURSIVE root AS (SELECT id, id AS root_id, origin_line_id AS pl FROM stock_lots WHERE source_lot_id IS NULL
    UNION ALL SELECT l.id, r.root_id, r.pl FROM stock_lots l JOIN root r ON l.source_lot_id = r.id)`;
const outsideBatches: Def = { id: "outside-batches", title: "دفعات «الربح خارج التوزيع»", basis: "snapshot", filters: ["from", "to", "partyId", "productId"],
  definition: "لكل سطر شراء مصنَّف «الربح خارج التوزيع»: المورد ورقم وتاريخ فاتورة الشراء والمادة والكمية وكلفة الشراء، وأين البضاعة الآن (موقع)، والمباع والمرتجع والمتبقي. الربط فعلي عبر الطبقات (حتى بعد التحويل بين المخزن والعهدة)، لا بالأسماء. «من/إلى» على تاريخ فاتورة الشراء. الحالة حتى اليوم.",
  async run(tx, f) {
    const rows = await tx.unsafe(`${ROOT_LOTS}
      SELECT pl.id AS plid, po.id AS poid, po.doc_no, po.doc_date::text AS pdate, c.name AS supplier, p.code, p.name AS pname, pl.qty_base::text AS qty, (pl.line_total_base + pl.landed_cost_base)::text AS cost,
        COALESCE((SELECT string_agg(sl.name || ': ' || q.q, '، ') FROM (SELECT l.location_id, sum(l.qty_remaining)::text AS q FROM stock_lots l JOIN root r ON r.id = l.id WHERE r.pl = pl.id AND l.qty_remaining > 0 GROUP BY l.location_id) q JOIN stock_locations sl ON sl.id = q.location_id), '—') AS locs,
        COALESCE((SELECT sum(l.qty_remaining) FROM stock_lots l JOIN root r ON r.id = l.id WHERE r.pl = pl.id), 0)::text AS remaining,
        COALESCE((SELECT sum(cn.qty) FROM stock_lot_consumptions cn JOIN root r ON r.id = cn.lot_id JOIN delivery_lines dl ON dl.id = cn.doc_line_id JOIN delivery_notes dn ON dn.id = dl.delivery_id
                  WHERE r.pl = pl.id AND cn.doc_type = 'delivery_note' AND dn.status = 'POSTED'), 0)::text AS sold,
        COALESCE((SELECT sum(rt.qty) FROM stock_lot_returns rt JOIN root r ON r.id = rt.lot_id JOIN sales_returns sr ON sr.id = rt.return_id WHERE r.pl = pl.id AND sr.status = 'POSTED'), 0)::text AS returned
      FROM purchase_lines pl JOIN purchase_orders po ON po.id = pl.purchase_id JOIN contacts c ON c.id = po.supplier_id JOIN products p ON p.id = pl.product_id
      WHERE pl.profit_class = 'USED' AND po.status = 'POSTED' AND (${f.from ? `po.doc_date >= '${f.from.replace(/'/g, "")}'` : "true"}) AND (${f.to ? `po.doc_date <= '${f.to.replace(/'/g, "")}'` : "true"})
        AND (${f.partyId ? `po.supplier_id = '${f.partyId.replace(/'/g, "")}'` : "true"}) AND (${f.productId ? `pl.product_id = '${f.productId.replace(/'/g, "")}'` : "true"}) ORDER BY po.doc_date, po.doc_no, pl.line_no`);
    const out: Row[] = rows.map((r: any) => ({ supplier: r.supplier, poNo: r.doc_no, poLink: `/purchases/${r.poid}`, poDate: r.pdate, product: `${r.code} — ${r.pname}`, qty: r.qty, cost: r.cost, currency: "IQD", locs: r.locs, sold: r.sold, returned: r.returned, remaining: r.remaining }));
    return { columns: [{ key: "supplier", label: "المورد" }, { key: "poNo", label: "فاتورة الشراء", href: "poLink" }, { key: "poDate", label: "تاريخ الشراء" }, { key: "product", label: "المادة" }, { key: "qty", label: "الكمية المشتراة", kind: "qty" }, { key: "cost", label: "كلفة الشراء (IQD)", kind: "money", cur: "IQD" }, { key: "locs", label: "الموقع (المتبقي)" }, { key: "sold", label: "المباع", kind: "qty" }, { key: "returned", label: "المرتجع", kind: "qty" }, { key: "remaining", label: "المتبقي", kind: "qty" }],
      rows: out, totals: out.length ? [{ supplier: "الإجمالي", currency: "IQD", cost: sum(out, "cost").toString() }] : [], notes: ["الكميات بوحدة المادة الأساسية", "الربط عبر الطبقات الفعلية، ويبقى التصنيف مع الطبقة عند التحويل"] };
  } };

const outsideSales: Def = { id: "outside-sales", title: "مبيعات «الربح خارج التوزيع» وتحصيلها", basis: "period", filters: ["from", "to", "partyId", "productId"],
  definition: "لكل بند بيع من دفعات «الربح خارج التوزيع» وكل طبقة سُحب منها (FIFO): العميل والفاتورة، المورد وفاتورة الشراء، سعر البيع الحقيقي والخصم وصافي المبيعات، الكلفة الفعلية، الربح/الخسارة. وعلى مستوى الفاتورة: ما سدده العميل، المتبقي، الداخل للصندوق، المستلم خارج الصندوق. «من/إلى» على تاريخ فاتورة البيع. أعمدة الفاتورة تتكرر على صفوفها ولا تُجمع مرتين (الإجمالي على الفواتير المميزة). الربح هنا تجاري ومستبعد من الشراكة.",
  async run(tx, f) {
    const q = (v: string | undefined, c: string) => (v ? `${c} = '${v.replace(/'/g, "")}'` : "true");
    const rows = await tx.unsafe(`${ROOT_LOTS}
      SELECT si.id AS iid, si.doc_no AS ino, si.doc_date::text AS idate, si.currency, c.name AS customer, sl.id AS slid, p.code, p.name AS pname, sl.qty_base::text AS lq, sl.unit_price::text AS uprice,
        sl.line_total::text AS lgross, sl.net_line_orig::text AS lnet, sl.net_line_base::text AS lnetb, cn.qty::text AS cq, cn.cost_base::text AS ccost, po.id AS poid, po.doc_no AS pono, sup.name AS supplier,
        COALESCE((SELECT sum(rt.qty) FROM stock_lot_returns rt JOIN sales_returns sr ON sr.id = rt.return_id WHERE rt.delivery_line_id = dl.id AND rt.lot_id = cn.lot_id AND sr.status = 'POSTED'), 0)::text AS rq,
        COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = si.id AND r.status = 'POSTED' AND NOT a.external), 0)::text AS inbox,
        COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = si.id AND r.status = 'POSTED' AND a.external AND a.external_kind = 'OUTSIDE_MARGIN'), 0)::text AS outside,
        COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = si.id AND r.status = 'POSTED' AND a.external AND a.external_kind = 'PROFIT_SHARE'), 0)::text AS shared,
        COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED'), 0)::text AS applied, si.net::text AS inet, sl.qty_base AS lqty,
        (SELECT string_agg(r.doc_no, '، ' ORDER BY r.doc_date) FROM customer_receipts r WHERE r.status = 'POSTED' AND EXISTS (SELECT 1 FROM receipt_allocations a WHERE a.receipt_id = r.id AND a.invoice_id = si.id)) AS receipts
      FROM sales_lines sl JOIN sales_invoices si ON si.id = sl.invoice_id JOIN contacts c ON c.id = si.customer_id JOIN products p ON p.id = sl.product_id
        JOIN delivery_lines dl ON dl.sales_line_id = sl.id JOIN delivery_notes dn ON dn.id = dl.delivery_id AND dn.status = 'POSTED'
        JOIN stock_lot_consumptions cn ON cn.doc_line_id = dl.id AND cn.doc_type = 'delivery_note' JOIN root rt ON rt.id = cn.lot_id
        LEFT JOIN purchase_lines pl ON pl.id = rt.pl LEFT JOIN purchase_orders po ON po.id = pl.purchase_id LEFT JOIN contacts sup ON sup.id = po.supplier_id
      WHERE sl.profit_class = 'USED' AND si.status = 'POSTED' AND ${f.from ? `si.doc_date >= '${f.from.replace(/'/g, "")}'` : "true"} AND ${f.to ? `si.doc_date <= '${f.to.replace(/'/g, "")}'` : "true"}
        AND ${q(f.partyId, "si.customer_id")} AND ${q(f.productId, "sl.product_id")} ORDER BY si.doc_date, si.doc_no, sl.line_no`);
    const out: Row[] = []; const seen = new Set<string>();
    const tot = new Map<string, { net: ReturnType<typeof d>; cost: ReturnType<typeof d>; profit: ReturnType<typeof d>; paid: ReturnType<typeof d>; rem: ReturnType<typeof d>; box: ReturnType<typeof d>; outside: ReturnType<typeof d> }>();
    for (const r of rows as any[]) {
      const share = d(r.cq).div(r.lqty), cur = r.currency as string, places = cur === "USD" ? 4 : 4;
      const grossS = d(r.lgross).mul(share).toDecimalPlaces(places), netS = d(r.lnet).mul(share).toDecimalPlaces(places), netB = d(r.lnetb).mul(share);
      const cost = d(r.ccost), profit = netB.minus(cost), discS = grossS.minus(netS);
      const paid = d(r.inbox).plus(r.outside).plus(r.shared), remaining = d(r.inet).minus(paid).minus(r.applied);
      out.push({ customer: r.customer, invoiceNo: r.ino, invoiceLink: `/sales/${r.iid}`, invoiceDate: r.idate, supplier: r.supplier ?? "—", purchaseNo: r.pono ?? "—", purchaseLink: r.poid ? `/purchases/${r.poid}` : null, product: `${r.code} — ${r.pname}`,
        qty: r.cq, returned: r.rq, unitPrice: r.uprice, gross: grossS.toString(), discount: discS.toString(), net: netS.toString(), cost: cost.toString(), profit: profit.toString(), currency: cur,
        paid: paid.toString(), remaining: Decimal0(remaining).toString(), box: r.inbox, outside: r.outside, receipts: r.receipts ?? "—" });
      const t = tot.get(cur) ?? { net: d(0), cost: d(0), profit: d(0), paid: d(0), rem: d(0), box: d(0), outside: d(0) };
      t.net = t.net.plus(netS); t.cost = t.cost.plus(cost); t.profit = t.profit.plus(profit);
      if (!seen.has(r.iid)) { seen.add(r.iid); t.paid = t.paid.plus(paid); t.rem = t.rem.plus(Decimal0(remaining)); t.box = t.box.plus(r.inbox); t.outside = t.outside.plus(r.outside); }
      tot.set(cur, t);
    }
    const totals: Row[] = [...tot].map(([cur, t]) => ({ customer: `الإجمالي ${cur} (الفواتير مرة واحدة)`, currency: cur, net: t.net.toString(), cost: t.cost.toString(), profit: t.profit.toString(), paid: t.paid.toString(), remaining: t.rem.toString(), box: t.box.toString(), outside: t.outside.toString() }));
    return { columns: [{ key: "customer", label: "العميل" }, { key: "invoiceNo", label: "فاتورة البيع", href: "invoiceLink" }, { key: "invoiceDate", label: "تاريخ البيع" }, { key: "supplier", label: "المورد" }, { key: "purchaseNo", label: "فاتورة الشراء", href: "purchaseLink" }, { key: "product", label: "المادة" },
      { key: "qty", label: "الكمية (من هذه الدفعة)", kind: "qty" }, { key: "returned", label: "المرتجع", kind: "qty" }, { key: "unitPrice", label: "سعر البيع", kind: "money" }, { key: "gross", label: "قبل الخصم", kind: "money" }, { key: "discount", label: "الخصم", kind: "money" }, { key: "net", label: "صافي المبيعات", kind: "money" },
      { key: "cost", label: "الكلفة الفعلية (IQD)", kind: "money", cur: "IQD" }, { key: "profit", label: "الربح/الخسارة (IQD)", kind: "money", cur: "IQD" },
      { key: "paid", label: "سدده العميل (للفاتورة)", kind: "money" }, { key: "remaining", label: "المتبقي (للفاتورة)", kind: "money" }, { key: "box", label: "دخل الصندوق (للفاتورة)", kind: "money" }, { key: "outside", label: "المستلم خارج الصندوق (للفاتورة)", kind: "money" }, { key: "receipts", label: "سندات القبض" }],
      rows: out, totals, notes: ["الربح تجاري ومستبعد من توزيع الشراكة ولا ينشئ حصة لأحد", "المبالغ بعملة الفاتورة؛ الكلفة والربح بالدينار", "ما دخل الصندوق وما استُلم خارجه وما بقي ذمة ثلاثة أرقام مستقلة"] };
  } };

export const REPORTS: Def[] = [customerInvoices, outsideBatches, outsideSales, profits, trial, ledger, pnl, bs, statement("customer"), statement("supplier"), inventory, cashMv];
export const reportById = (id: string) => REPORTS.find((r) => r.id === id);
