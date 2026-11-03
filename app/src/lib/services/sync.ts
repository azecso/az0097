// Offline sync. The device may only send DRAFT operations (create / update / ask-to-post). The SERVER decides everything that is
// financial: numbering, FIFO, cash, credit limit, period — inside the same transactions as online use. No last-write-wins on amounts.
import { z } from "zod";
import type postgres from "postgres";
import { sql, withTenant, type Tx } from "../db";
import { AppError } from "../errors";
import { audit, type Actor } from "../audit";
import { can, type Action, type Principal } from "../authz";
import { createInvoice, invoiceSchema, invoiceUpdateSchema, postInvoice, updateInvoice, createQuote, quoteSchema, quoteUpdateSchema, updateQuote, issueQuote, getInvoice, getQuote } from "./sales";
import { createReceipt, postReceipt, receiptSchema } from "./receipts";
import { createExpense, expenseSchema, postExpense } from "./expenses";

export const ENTITIES = ["sales_invoice", "sales_quote", "customer_receipt", "expense"] as const;
type Entity = (typeof ENTITIES)[number];
const RESOURCE: Record<Entity, string> = { sales_invoice: "sales", sales_quote: "sales", customer_receipt: "voucher", expense: "expense" };

export const opSchema = z.object({
  operationId: z.string().uuid(), idempotencyKey: z.string().min(8).max(200), entityType: z.enum(ENTITIES), entityLocalId: z.string().uuid(),
  op: z.enum(["CREATE_DRAFT", "UPDATE_DRAFT", "SUBMIT_FOR_POSTING"]), baseVersion: z.number().int().nullish(), payload: z.record(z.string(), z.unknown()).default({}), clientCreatedAt: z.string().datetime(),
});
export const pushSchema = z.object({ deviceId: z.string().min(3).max(100), operations: z.array(opSchema).min(1).max(100) });
export type SyncOp = z.infer<typeof opSchema>;
export interface OpResult { operationId: string; status: "ACCEPTED" | "REJECTED" | "CONFLICT"; code?: string; message?: string; serverId?: string; docNo?: string | null; draftRef?: string; version?: number; serverSnapshot?: unknown; issues?: unknown }

const CONFLICT_KIND: Record<string, string> = { INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK", INSUFFICIENT_CASH: "INSUFFICIENT_CASH", CREDIT_LIMIT_EXCEEDED: "CREDIT_LIMIT", PERIOD_CLOSED: "PERIOD_CLOSED", VERSION_MISMATCH: "VERSION_MISMATCH", VERSION_CONFLICT: "VERSION_MISMATCH" };

async function resolveServerId(tx: Tx, op: SyncOp): Promise<string | null> {
  const [r] = await tx`SELECT server_entity_id FROM sync_operations WHERE entity_local_id = ${op.entityLocalId} AND op = 'CREATE_DRAFT' AND status = 'ACCEPTED' ORDER BY received_at LIMIT 1`;
  return (r?.server_entity_id as string | undefined) ?? null;
}

async function execute(tx: Tx, who: Principal, actor: Actor, op: SyncOp): Promise<Omit<OpResult, "operationId">> {
  const action: Action = op.op === "CREATE_DRAFT" ? "create" : op.op === "UPDATE_DRAFT" ? "edit_draft" : "approve";
  if (!(await can(tx, who, RESOURCE[op.entityType], action))) throw new AppError(403, "PERMISSION_DENIED", "صلاحيتك لا تسمح بهذه العملية (ربما تغيّرت بعد كتابة المسودة)");
  if (op.op === "CREATE_DRAFT") {
    const dup = await resolveServerId(tx, op);                                   // the same local draft can only become ONE server document
    if (dup) return { status: "ACCEPTED", serverId: dup, code: "ALREADY_CREATED" };
    let r: Record<string, any>;
    if (op.entityType === "sales_invoice") r = await createInvoice(tx, who, actor, invoiceSchema.parse(op.payload));
    else if (op.entityType === "sales_quote") r = await createQuote(tx, who, actor, quoteSchema.parse(op.payload));
    else if (op.entityType === "customer_receipt") r = await createReceipt(tx, who, actor, receiptSchema.parse(op.payload));
    else r = await createExpense(tx, who, actor, expenseSchema.parse(op.payload));
    return { status: "ACCEPTED", serverId: r.id, draftRef: r.draftRef, version: r.version };
  }
  const serverId = (op.payload.serverId as string | undefined) ?? (await resolveServerId(tx, op));
  if (!serverId) throw new AppError(409, "DEPENDS_ON_CREATE", "لم تُنشأ المسودة على الخادم بعد");
  if (op.op === "UPDATE_DRAFT") {
    const rest = { ...op.payload }; delete rest.serverId;
    if (op.baseVersion === null || op.baseVersion === undefined) throw new AppError(400, "BASE_VERSION_REQUIRED");
    const body = { ...rest, version: op.baseVersion };
    if (op.entityType === "sales_invoice") { const r = await updateInvoice(tx, who, actor, serverId, invoiceUpdateSchema.parse(body)); return { status: "ACCEPTED", serverId, version: r.version }; }
    if (op.entityType === "sales_quote") { const r = await updateQuote(tx, who, actor, serverId, quoteUpdateSchema.parse(body)); return { status: "ACCEPTED", serverId, version: r.version }; }
    throw new AppError(400, "UPDATE_NOT_SUPPORTED", "تعديل هذا النوع غير مدعوم أوفلاين؛ احذف المسودة وأنشئ غيرها");
  }
  let r: Record<string, any>;                                                    // SUBMIT_FOR_POSTING: full server-side validation, FIFO lock, numbering, journal
  if (op.entityType === "sales_invoice") r = await postInvoice(tx, who, actor, serverId);
  else if (op.entityType === "sales_quote") r = await issueQuote(tx, who, actor, serverId);
  else if (op.entityType === "customer_receipt") r = await postReceipt(tx, who, actor, serverId);
  else r = await postExpense(tx, who, actor, serverId);
  return { status: "ACCEPTED", serverId, docNo: r.docNo };
}

async function snapshot(tx: Tx, op: SyncOp, serverId: string | null): Promise<unknown> {
  if (!serverId) return null;
  try {
    if (op.entityType === "sales_invoice") { const g = (await getInvoice(tx, serverId)) as Record<string, any>; return { version: g.version, status: g.status, net: g.net, customerName: g.customerName }; }
    if (op.entityType === "sales_quote") { const g = await getQuote(tx, serverId); return { version: g.version, status: g.status, total: g.total }; }
  } catch { /* snapshot is best effort */ }
  return null;
}

async function record(db: postgres.Sql, who: Principal, deviceId: string, op: SyncOp, res: OpResult, serverId: string | null, kind: string | null) {
  await withTenant(who.companyId, async (tx) => {
    await tx`UPDATE sync_operations SET status = ${res.status}, result_code = ${res.code ?? null}, result = ${tx.json(res as never)}, server_entity_id = ${serverId} WHERE operation_id = ${op.operationId}`;
    if (res.status === "CONFLICT") await tx`INSERT INTO sync_conflicts(company_id, operation_id, kind, detail, server_snapshot) VALUES (${who.companyId}, ${op.operationId}, ${kind ?? "OTHER"}, ${res.message ?? null}, ${res.serverSnapshot === undefined ? null : tx.json(res.serverSnapshot as never)})`;
  }, db);
}

/** Each operation runs in its OWN transaction: one failing/conflicting operation never rolls back or blocks the others. */
export async function pushOperations(who: Principal, ip: string | null, body: z.infer<typeof pushSchema>, db: postgres.Sql = sql): Promise<OpResult[]> {
  const out: OpResult[] = [];
  const actor: Actor = { userId: who.userId, companyId: who.companyId, ip, deviceId: body.deviceId };
  for (const op of body.operations) {
    // 1) idempotency: a known operation (or key) returns its stored outcome and is NOT executed again
    const prior = await withTenant(who.companyId, async (tx) => {
      const [p] = await tx`SELECT operation_id, status, result FROM sync_operations WHERE operation_id = ${op.operationId} OR idempotency_key = ${op.idempotencyKey} LIMIT 1`;
      if (p) return p;
      await tx`INSERT INTO sync_operations(company_id, operation_id, idempotency_key, device_id, user_id, entity_type, entity_local_id, op, base_version, payload, client_created_at)
        VALUES (${who.companyId}, ${op.operationId}, ${op.idempotencyKey}, ${body.deviceId}, ${who.userId}, ${op.entityType}, ${op.entityLocalId}, ${op.op}, ${op.baseVersion ?? null}, ${tx.json(op.payload as never)}, ${op.clientCreatedAt})`;
      return null;
    }, db);
    if (prior && prior.status !== "RECEIVED") { out.push({ ...(prior.result as OpResult), operationId: prior.operation_id, replayed: true } as OpResult); continue; }
    // 2) run it
    let res: OpResult; let serverId: string | null = null; let kind: string | null = null;
    try {
      const r = await withTenant(who.companyId, async (tx) => {
        const x = await execute(tx, who, actor, op);
        await audit(tx, actor, { action: `sync.${op.op.toLowerCase()}`, entityType: op.entityType, entityId: x.serverId ?? null, after: { operationId: op.operationId, deviceId: body.deviceId } });
        return x;
      }, db);
      serverId = r.serverId ?? null; res = { operationId: op.operationId, ...r };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "ERROR";
      if (e instanceof z.ZodError) res = { operationId: op.operationId, status: "REJECTED", code: "VALIDATION", message: "بيانات غير صالحة", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
      else if (e instanceof AppError && CONFLICT_KIND[e.code]) {
        kind = CONFLICT_KIND[e.code]!; serverId = (op.payload.serverId as string | undefined) ?? (await withTenant(who.companyId, (tx) => resolveServerId(tx, op), db));
        res = { operationId: op.operationId, status: "CONFLICT", code: e.code, message: e.message, serverSnapshot: await withTenant(who.companyId, (tx) => snapshot(tx, op, serverId), db) };
      } else if (e instanceof AppError) res = { operationId: op.operationId, status: "REJECTED", code: e.code, message: e.message };
      else { const pg = e as { message?: string }; res = { operationId: op.operationId, status: "REJECTED", code: code === "ERROR" ? "SERVER_ERROR" : code, message: (pg.message ?? "").slice(0, 200) }; }
    }
    await record(db, who, body.deviceId, op, res, serverId, kind);
    out.push(res);
  }
  return out;
}

export async function listOperations(tx: Tx, userId: string, deviceId?: string) {
  return tx`SELECT operation_id AS "operationId", device_id AS "deviceId", entity_type AS "entityType", op, status, result_code AS code, result, received_at AS "receivedAt", server_entity_id AS "serverId"
    FROM sync_operations WHERE user_id = ${userId} AND (${deviceId ?? null}::text IS NULL OR device_id = ${deviceId ?? null}) ORDER BY received_at DESC LIMIT 200`;
}

/** Reference data the device may cache for offline drafting (read-only, no balances/financial totals). */
export async function referenceSnapshot(tx: Tx) {
  const [products, contacts, locations, cash, fx, company] = await Promise.all([
    tx`SELECT p.id, p.code, p.name, p.base_uom AS "baseUom", p.qty_decimals AS "qtyDecimals", p.default_sale_price::text AS "defaultSalePrice", p.default_purchase_price::text AS "defaultPurchasePrice",
        COALESCE((SELECT json_agg(json_build_object('uom', u.uom, 'factorToBase', u.factor_to_base::text)) FROM product_uoms u WHERE u.product_id = p.id), '[]') AS uoms FROM products p WHERE NOT p.is_archived ORDER BY p.code`,
    tx`SELECT id, kind, code, name, payment_terms_days AS "paymentTermsDays" FROM contacts WHERE NOT is_archived ORDER BY name`,
    tx`SELECT sl.id, sl.name, w.kind FROM stock_locations sl JOIN warehouses w ON w.id = sl.warehouse_id`,
    tx`SELECT id, name, currency, kind, counts_toward_available_cash AS "countsTowardAvailable" FROM cash_accounts WHERE is_active`,
    tx`SELECT currency, rate_date::text AS "rateDate", rate::text AS rate FROM fx_rates ORDER BY rate_date DESC LIMIT 30`,
    tx`SELECT name, base_currency AS "baseCurrency", landed_cost_policy AS "landedCostPolicy" FROM companies`,
  ]);
  const categories = await tx`SELECT id, name FROM expense_categories WHERE is_active ORDER BY name`;
  return { asOf: new Date().toISOString(), products, contacts, locations, cashAccounts: cash, fxRates: fx, company: company[0], expenseCategories: categories };
}
