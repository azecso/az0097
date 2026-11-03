import { call, loginAs, setupDb, OWNER_PW, ACCT_PW, type Session, type TestEnv } from "./helpers";

type H = (req: any, c: any) => Promise<Response>;
const imp = async (p: string) => import(p);

export interface World {
  env: TestEnv; owner: Session; acct: Session; R: Record<string, any>;
  ids: { main: string; partner: string; cashIQD: string; cashUSD: string; supplier: string };
  api: (s: Session, h: H, o?: Parameters<typeof call>[1]) => ReturnType<typeof call>;
  mkProduct: (code: string, extra?: Record<string, unknown>) => Promise<string>;
  inject: <T>(fn: (tx: any, actor: any, libs: { postJournal: any; consumeFifo: any; receiveLot: any }) => Promise<T>) => Promise<T>;
  tb: () => Promise<any>; recon: () => Promise<any>;
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
  R.statement = (await imp("@/app/api/contacts/[id]/statement/route")).GET;
  R.fx = (await imp("@/app/api/fx-rates/route")).POST;
  R.lots = (await imp("@/app/api/products/[id]/lots/route")).GET;
  const owner = await loginAs(R.login, "owner", OWNER_PW);
  await call(R.users.POST, { method: "POST", session: owner, body: { username: "acc", displayName: "المحاسب", password: ACCT_PW } });
  const acct = await loginAs(R.login, "acc", ACCT_PW);
  const api: World["api"] = (s, h, o) => call(h as any, { ...o, session: s });
  const locs = (await api(owner, R.locations)).body, cash = (await api(owner, R.cash)).body;
  const sup = await api(owner, R.contacts.POST, { method: "POST", body: { kind: "SUPPLIER", code: "S1", name: "مورد الاختبار" } });
  const ids = { main: locs.find((l: any) => l.kind === "MAIN").id, partner: locs.find((l: any) => l.kind === "PARTNER_CUSTODY").id,
    cashIQD: cash.find((c: any) => c.currency === "IQD" && c.kind === "MAIN_CASH").id, cashUSD: cash.find((c: any) => c.currency === "USD").id, supplier: sup.body.id };
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
  return { env, owner, acct, R, ids, api, mkProduct, inject, buy,
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
