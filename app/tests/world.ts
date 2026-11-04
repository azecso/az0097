import { call, loginAs, setupDb, OWNER_PW, ACCT_PW, type Session, type TestEnv } from "./helpers";

type H = (req: any, c: any) => Promise<Response>;
const imp = async (p: string) => import(p);

export interface World {
  env: TestEnv; owner: Session; acct: Session; R: Record<string, any>;
  ids: { main: string; partner: string; cashIQD: string; cashUSD: string; custody: string; supplier: string; customer: string };
  api: (s: Session, h: H, o?: Parameters<typeof call>[1]) => ReturnType<typeof call>;
  mkProduct: (code: string, extra?: Record<string, unknown>) => Promise<string>;
  inject: <T>(fn: (tx: any, actor: any, libs: { postJournal: any; consumeFifo: any; receiveLot: any }) => Promise<T>) => Promise<T>;
  tb: () => Promise<any>; recon: () => Promise<any>; fund: (amount?: string) => Promise<void>; cat: (name: string) => Promise<string>;
  sale: (o: { product: string; qty: string; price: string; type?: "CASH" | "CREDIT"; date?: string; customer?: string; currency?: string; rate?: string; discount?: string; lineDiscount?: string; mode?: "WITH_INVOICE" | "SEPARATE"; locationId?: string; cash?: string; session?: Session; noPost?: boolean }) => Promise<any>;
  getInvoice: (id: string) => Promise<any>;
  buy: (o: { product: string; qty: string; price: string; date?: string; type?: "CASH" | "CREDIT"; currency?: string; rate?: string; uom?: string; locationId?: string; session?: Session }) => Promise<any>;
}

export async function makeWorld(): Promise<World> {
  const env = await setupDb();
  const R: Record<string, any> = {};
  R.login = (await imp("@/app/api/auth/login/route")).POST;
  R.users = await imp("@/app/api/users/route");
  R.contacts = await imp("@/app/api/contacts/route");
  R.products = await imp("@/app/api/products/route");
  R.productId = await imp("@/app/api/products/[id]/route");
  R.purchases = await imp("@/app/api/purchases/route");
  R.purchaseId = await imp("@/app/api/purchases/[id]/route");
  R.purchasePost = (await imp("@/app/api/purchases/[id]/post/route")).POST;
  R.purchaseReverse = (await imp("@/app/api/purchases/[id]/reverse/route")).POST;
  R.returns = await imp("@/app/api/purchase-returns/route");
  R.returnPost = (await imp("@/app/api/purchase-returns/[id]/post/route")).POST;
  R.payments = await imp("@/app/api/supplier-payments/route");
  R.paymentPost = (await imp("@/app/api/supplier-payments/[id]/post/route")).POST;
  R.paymentReverse = (await imp("@/app/api/supplier-payments/[id]/reverse/route")).POST;
  R.transfers = await imp("@/app/api/stock-transfers/route");
  R.transferPost = (await imp("@/app/api/stock-transfers/[id]/post/route")).POST;
  R.transferReverse = (await imp("@/app/api/stock-transfers/[id]/reverse/route")).POST;
  R.counts = await imp("@/app/api/inventory-counts/route");
  R.countPost = (await imp("@/app/api/inventory-counts/[id]/post/route")).POST;
  R.stock = (await imp("@/app/api/stock/route")).GET;
  R.locations = (await imp("@/app/api/locations/route")).GET;
  R.cash = (await imp("@/app/api/cash-accounts/route")).GET;
  R.trial = (await imp("@/app/api/reports/trial-balance/route")).GET;
  R.recon = (await imp("@/app/api/reports/inventory-reconciliation/route")).GET;
  R.capRet = await imp("@/app/api/capital-returns/route");
  R.capRetId = await imp("@/app/api/capital-returns/[id]/route");
  R.repSales = (await imp("@/app/api/reports/sales/route")).GET;
  R.repPurch = (await imp("@/app/api/reports/purchases/route")).GET;
  R.repBal = (await imp("@/app/api/reports/balances/route")).GET;
  R.repMove = (await imp("@/app/api/reports/product-movement/route")).GET;
  R.statement = (await imp("@/app/api/contacts/[id]/statement/route")).GET;
  R.fx = (await imp("@/app/api/fx-rates/route")).POST;
  R.invoices = await imp("@/app/api/sales-invoices/route");
  R.invoiceId = await imp("@/app/api/sales-invoices/[id]/route");
  R.invoicePost = (await imp("@/app/api/sales-invoices/[id]/post/route")).POST;
  R.invoiceReverse = (await imp("@/app/api/sales-invoices/[id]/reverse/route")).POST;
  R.deliveries = await imp("@/app/api/delivery-notes/route");
  R.deliveryPost = (await imp("@/app/api/delivery-notes/[id]/post/route")).POST;
  R.deliveryReverse = (await imp("@/app/api/delivery-notes/[id]/reverse/route")).POST;
  R.sreturns = await imp("@/app/api/sales-returns/route");
  R.sreturnPost = (await imp("@/app/api/sales-returns/[id]/post/route")).POST;
  R.sreturnReverse = (await imp("@/app/api/sales-returns/[id]/reverse/route")).POST;
  R.quotes = await imp("@/app/api/sales-quotes/route");
  R.quoteId = await imp("@/app/api/sales-quotes/[id]/route");
  R.quoteIssue = (await imp("@/app/api/sales-quotes/[id]/issue/route")).POST;
  R.quoteStatus = (await imp("@/app/api/sales-quotes/[id]/status/route")).POST;
  R.quoteConvert = (await imp("@/app/api/sales-quotes/[id]/convert/route")).POST;
  R.receipts = await imp("@/app/api/customer-receipts/route");
  R.receiptPost = (await imp("@/app/api/customer-receipts/[id]/post/route")).POST;
  R.receiptReverse = (await imp("@/app/api/customer-receipts/[id]/reverse/route")).POST;
  R.ctransfers = await imp("@/app/api/cash-transfers/route");
  R.ctransferPost = (await imp("@/app/api/cash-transfers/[id]/post/route")).POST;
  R.custStatement = (await imp("@/app/api/customers/[id]/statement/route")).GET;
  R.receivables = (await imp("@/app/api/reports/receivables/route")).GET;
  R.categories = await imp("@/app/api/expense-categories/route");
  R.expenses = await imp("@/app/api/expenses/route");
  R.expenseId = await imp("@/app/api/expenses/[id]/route");
  R.expensePost = (await imp("@/app/api/expenses/[id]/post/route")).POST;
  R.expenseReverse = (await imp("@/app/api/expenses/[id]/reverse/route")).POST;
  R.expensePay = await imp("@/app/api/expense-payments/route");
  R.employees = await imp("@/app/api/employees/route");
  R.payroll = await imp("@/app/api/payroll/route");
  R.payrollPost = (await imp("@/app/api/payroll/[id]/post/route")).POST;
  R.payrollReverse = (await imp("@/app/api/payroll/[id]/reverse/route")).POST;
  R.payrollPay = await imp("@/app/api/payroll-payments/route");
  R.capital = await imp("@/app/api/capital/route");
  R.capitalApprove = (await imp("@/app/api/capital/[id]/approve/route")).POST;
  R.capitalReject = (await imp("@/app/api/capital/[id]/reject/route")).POST;
  R.capitalReverse = (await imp("@/app/api/capital/[id]/reverse/route")).POST;
  R.advances = await imp("@/app/api/personal-advances/route");
  R.advancePost = (await imp("@/app/api/personal-advances/[id]/post/route")).POST;
  R.opening = await imp("@/app/api/opening/route");
  R.openingPost = (await imp("@/app/api/opening/post/route")).POST;
  R.periods = await imp("@/app/api/periods/route");
  R.settlements = await imp("@/app/api/profit-settlements/route");
  R.settlePreview = (await imp("@/app/api/profit-settlements/preview/route")).POST;
  R.settleApprove = (await imp("@/app/api/profit-settlements/[id]/approve/route")).POST;
  R.settleReverse = (await imp("@/app/api/profit-settlements/[id]/reverse/route")).POST;
  R.payouts = await imp("@/app/api/profit-payouts/route");
  R.payoutReverse = (await imp("@/app/api/profit-payouts/[id]/reverse/route")).POST;
  R.partners = (await imp("@/app/api/partners/route")).GET;
  R.partnerStatement = (await imp("@/app/api/partners/[id]/statement/route")).GET;
  R.totp = await imp("@/app/api/auth/totp/route");
  R.lots = (await imp("@/app/api/products/[id]/lots/route")).GET;
  const owner = await loginAs(R.login, "owner", OWNER_PW);
  await call(R.users.POST, { method: "POST", session: owner, body: { username: "acc", displayName: "المحاسب", password: ACCT_PW } });
  const acct = await loginAs(R.login, "acc", ACCT_PW);
  const api: World["api"] = (s, h, o) => call(h as any, { ...o, session: s });
  const locs = (await api(owner, R.locations)).body, cash = (await api(owner, R.cash)).body;
  const sup = await api(owner, R.contacts.POST, { method: "POST", body: { kind: "SUPPLIER", code: "S1", name: "مورد الاختبار" } });
  const ids = { main: locs.find((l: any) => l.kind === "MAIN").id, partner: locs.find((l: any) => l.kind === "PARTNER_CUSTODY").id,
    cashIQD: cash.find((c: any) => c.currency === "IQD" && c.kind === "MAIN_CASH").id, cashUSD: cash.find((c: any) => c.currency === "USD").id, custody: cash.find((c: any) => c.kind === "PARTNER_CUSTODY").id, supplier: sup.body.id, customer: "" };
  const cus = await api(owner, R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "C1", name: "عميل الاختبار" } });
  ids.customer = cus.body.id;
  await api(owner, R.fx, { method: "POST", body: { currency: "USD", rateDate: "2026-01-01", rate: "1450" } });
  const mkProduct: World["mkProduct"] = async (code, extra = {}) => {
    const r = await api(owner, R.products.POST, { method: "POST", body: { code, name: "مادة " + code, baseUom: "قطعة", qtyDecimals: 0, ...extra } });
    if (r.status !== 200) throw new Error("mkProduct " + JSON.stringify(r.body));
    return r.body.id;
  };
  const inject: World["inject"] = async (fn) => {
    const { withTenant } = await imp("@/lib/db"); const lg = await imp("@/lib/ledger"); const inv = await imp("@/lib/inventory");
    return withTenant(env.companyId, (tx: any) => fn(tx, { userId: env.ownerId, companyId: env.companyId }, { postJournal: lg.postJournal, consumeFifo: inv.consumeFifo, receiveLot: inv.receiveLot }));
  };
  const buy: World["buy"] = async (o) => {
    const s = o.session ?? owner;
    const c = await api(s, R.purchases.POST, { method: "POST", body: { supplierId: ids.supplier, docDate: o.date ?? "2026-02-01", paymentType: o.type ?? "CASH",
      cashAccountId: (o.type ?? "CASH") === "CASH" ? (o.currency === "USD" ? ids.cashUSD : ids.cashIQD) : undefined, currency: o.currency ?? "IQD", exchangeRate: o.rate,
      lines: [{ productId: o.product, uom: o.uom ?? "قطعة", qty: o.qty, unitPrice: o.price, locationId: o.locationId }] } });
    if (c.status !== 200) return c;
    const p = await api(s, R.purchasePost, { method: "POST", params: { id: c.body.id } });
    return { ...p, id: c.body.id };
  };
  const sale: World["sale"] = async (o) => {
    const s = o.session ?? owner, type = o.type ?? "CREDIT";
    const c = await api(s, R.invoices.POST, { method: "POST", body: { customerId: o.customer ?? ids.customer, docDate: o.date ?? "2026-03-01", saleType: type, currency: o.currency ?? "IQD", exchangeRate: o.rate,
      cashAccountId: type === "CASH" ? (o.cash ?? (o.currency === "USD" ? ids.cashUSD : ids.cashIQD)) : undefined, discount: o.discount ?? "0", deliveryMode: o.mode ?? "WITH_INVOICE",
      lines: [{ productId: o.product, uom: "قطعة", qty: o.qty, unitPrice: o.price, lineDiscount: o.lineDiscount ?? "0", locationId: o.locationId }] } });
    if (c.status !== 200 || o.noPost) return c;
    const p = await api(s, R.invoicePost, { method: "POST", params: { id: c.body.id } });
    return { ...p, id: c.body.id };
  };
  const fund = async (amount = "10000000") => {                                   // capital injection through the real request/approve flow
    const r = await api(acct, R.capital.POST, { method: "POST", body: { kind: "INJECTION", docDate: "2026-01-01", cashAccountId: ids.cashIQD, currency: "IQD", amount, reason: "رأس مال ابتدائي" } });
    const a = await api(owner, R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
    if (a.status !== 200) throw new Error("fund failed " + JSON.stringify(a.body));
  };
  const cat = async (name: string) => (await api(owner, R.categories.GET)).body.find((c: any) => c.name === name).id as string;
  return { env, owner, acct, R, ids, api, mkProduct, inject, buy, sale, fund, cat, getInvoice: async (id: string) => (await api(owner, R.invoiceId.GET, { params: { id } })).body,
    tb: async () => (await api(owner, R.trial)).body, recon: async () => (await api(owner, R.recon)).body };
}
export async function capital(w: World, amount = "10000000") {
  await w.inject((tx, actor, l) => l.postJournal(tx, actor, { date: "2026-01-01", sourceDocType: "capital", sourceDocId: crypto.randomUUID(), memo: "رأس المال",
    lines: [{ account: "1110", debit: amount }, { account: "3100", credit: amount }] }));
}
export const bal = (tb: any, code: string) => { const r = tb.rows.find((x: any) => x.code === code); return r ? Number(r.debit) - Number(r.credit) : 0; };

/** Asserts a promise rejects and that code or message matches. */
export async function expectFail(p: Promise<unknown>, re: RegExp) {
  try { await p; } catch (e: any) { const t = `${e?.code ?? ""} ${e?.message ?? ""}`; if (!re.test(t)) throw new Error(`rejected with "${t}" which does not match ${re}`); return; }
  throw new Error(`expected rejection matching ${re} but it resolved`);
}
/** A real stock outflow: FIFO consume + balanced COGS journal (what Phase 3 sales will do), so books stay reconcilable. */
export async function sell(w: World, product: string, loc: string, qty: string): Promise<string> {
  return w.inject(async (tx, a, l) => {
    const docId = crypto.randomUUID();
    const out = await l.consumeFifo(tx, a.companyId, { productId: product, locationId: loc, qtyBase: qty, type: "SALE_OUT", docType: "test_sale", docId, docLineId: crypto.randomUUID(), at: new Date() });
    const inv = loc === w.ids.main ? "1300" : "1310";
    await l.postJournal(tx, a, { date: "2026-12-01", sourceDocType: "test_sale", sourceDocId: docId, lines: [{ account: "5100", debit: out.cost }, { account: inv, credit: out.cost }] });
    return out.cost.toString();
  });
}

export const uid = () => crypto.randomUUID();
/** Builds one sync operation the way a device would. */
export const op = (o: { entity: string; kind: "CREATE_DRAFT" | "UPDATE_DRAFT" | "SUBMIT_FOR_POSTING"; local: string; payload?: Record<string, unknown>; base?: number; key?: string; id?: string }) => ({
  operationId: o.id ?? uid(), idempotencyKey: o.key ?? "k-" + uid(), entityType: o.entity, entityLocalId: o.local, op: o.kind, baseVersion: o.base ?? null, payload: o.payload ?? {}, clientCreatedAt: new Date().toISOString(),
});
