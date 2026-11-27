import { randomUUID } from 'node:crypto';
import type { RequestActorSnapshot } from './authority-repository-async';
import { CommitOutcomeUnknownError } from './sql-postgres';
import {
  AccountWriteError,
  accountClock,
  type AccountRecord,
} from './session-repository-async';
import {
  requireOrderWriteActor,
  withCapturedOrderWrite,
} from './order-write-authority-async';
import {
  safeSqlInteger,
  sqlQuery,
  type AsyncSqlDatabase,
  type SqlReader,
} from './sql-database';
import { parseWeeklyLimit } from './weekly-order-limit';
import type { Order } from './types';
import {
  OrderLimitRepository,
  type FinalizationLimitGate,
  type OrderLimitOptions,
} from './order-limit-repository-async';
import {
  OrderUnavailableError,
  countsWeeklyOrder,
  finalizationWeekKey,
  orderBody,
  orderFromRow,
  orderInputHash,
  orderSetting,
  orderText,
  readFinalizationClient,
  readOrderForWrite,
  validateFinalizationProducts,
  type FinalizationCatalog,
} from './order-finalization-state-async';

export type OrderExportIntent = Readonly<{
  kind: 'order-finalization-v1';
  operationId: string;
  orderId: string;
  exportKey: string | null;
  draftRevision: number;
  actorId: string;
  actorProfileVersion: number;
  actorScopeRevision: number;
  draftPayloadSha256: string;
  finalOrderSha256: string;
  createdAt: string;
}>;
export type ExportDisposition =
  | 'committed'
  | 'rolled_back'
  | 'concurrent_finalization';
/**
 * The production adapter must durably record begin before staging an immutable,
 * private object. It must enforce the exact intent/key binding and must not make
 * the staged export readable until the authorized finalized order references it.
 * No production implementation is installed by this source-only port.
 */
export interface OrderExportLifecycle {
  begin(intent: OrderExportIntent): Promise<void>;
  stage(
    intent: OrderExportIntent,
    order: Readonly<Order>,
    catalog: FinalizationCatalog,
  ): Promise<void>;
  discard(intent: OrderExportIntent): Promise<void>;
  settle(
    intent: OrderExportIntent,
    disposition: ExportDisposition,
  ): Promise<void>;
}
export class FinalizationReconciliationRequiredError extends Error {
  readonly status = 503;
  readonly code = 'finalization_reconciliation_required';
  readonly retryUnsafe = true;
  constructor(
    readonly intent: OrderExportIntent,
    readonly phase:
      | 'journal_begin_unknown'
      | 'export_stage_unknown'
      | 'database_commit_unknown'
      | 'cleanup_pending'
      | 'journal_settle_pending',
    cause: unknown,
  ) {
    super(
      'Finalization requires reconciliation by order and export identity before retrying',
      { cause },
    );
    this.name = 'FinalizationReconciliationRequiredError';
  }
}
export type OrderFinalizationResult = Readonly<{
  order: Order;
  finalized: boolean;
  exportKey: string | null;
}>;
type Preparation = Readonly<{
  order: Order;
  payloadRaw: string;
  catalog: FinalizationCatalog;
  clientRaw: string | null;
  weeklyRaw: string | null;
  weeklyLimit: number;
  gate: FinalizationLimitGate;
}>;

/** Finalize only. Finalized orders cannot reopen; the existing copy flow creates a new draft. */
export class OrderFinalizationRepository {
  private readonly limits: OrderLimitRepository;
  private readonly schema: string;
  private readonly clock: () => number;
  private readonly applicationSchema: string;
  constructor(
    private readonly database: AsyncSqlDatabase,
    options: OrderLimitOptions,
  ) {
    this.limits = new OrderLimitRepository(database, options);
    this.schema = this.limits.schema;
    this.applicationSchema = options.applicationSchema;
    this.clock = options.clock ?? Date.now;
  }
  private async weekly(
    tx: SqlReader,
    order: Order,
  ): Promise<{ raw: string | null; limit: number }> {
    if (!countsWeeklyOrder(order)) return { raw: null, limit: 0 };
    const raw = await orderSetting(tx, this.schema, 'app'),
      stored: Record<string, unknown> = raw === null ? {} : JSON.parse(raw);
    const limit = parseWeeklyLimit(
      'weeklyLimit' in stored ? stored.weeklyLimit : 0,
    );
    if (limit === null)
      throw new OrderUnavailableError('invalid_weekly_order_limit');
    return { raw, limit };
  }
  private async preparation(
    tx: SqlReader,
    actor: AccountRecord,
    id: string,
    input: unknown,
  ): Promise<Preparation | OrderFinalizationResult> {
    const row = await readOrderForWrite(tx, this.schema, id, actor),
      order = orderFromRow(row);
    if (order.status === 'finalized')
      return { order, finalized: false, exportKey: this.exportKey(order) };
    const body = orderBody(input);
    if (body.revision !== order.revision)
      throw new AccountWriteError(409, 'order_changed');
    if (!order.pieces) throw new AccountWriteError(400, 'empty_order');
    const catalog = await this.limits.catalog(tx);
    validateFinalizationProducts(order, catalog);
    const clientRaw = await readFinalizationClient(tx, this.schema, order);
    const gate = await this.limits.prepareFinalization(
        tx,
        actor,
        order,
        catalog,
      ),
      weekly = await this.weekly(tx, order);
    return {
      order,
      payloadRaw: orderText(row.payload),
      catalog,
      clientRaw,
      weeklyRaw: weekly.raw,
      weeklyLimit: weekly.limit,
      gate,
    };
  }
  private exportKey(order: Order): string | null {
    const value = (order as Order & { exportKey?: unknown }).exportKey;
    return typeof value === 'string' ? value : null;
  }
  private async assertInputs(
    tx: SqlReader,
    actor: AccountRecord,
    prepared: Preparation,
  ): Promise<Order | null> {
    const row = await readOrderForWrite(
        tx,
        this.schema,
        prepared.order.id,
        actor,
      ),
      order = orderFromRow(row);
    if (order.status === 'finalized') return order;
    if (
      order.revision !== prepared.order.revision ||
      orderText(row.payload) !== prepared.payloadRaw ||
      order.userId !== prepared.order.userId ||
      order.warehouseId !== prepared.order.warehouseId
    )
      throw new AccountWriteError(409, 'order_changed');
    if (
      (await orderSetting(tx, this.schema, 'catalog')) !==
        prepared.catalog.raw ||
      (await orderSetting(tx, this.schema, 'inventory-ean-v1')) !==
        prepared.catalog.mappingsRaw
    )
      throw new AccountWriteError(409, 'catalog_changed');
    if (
      (await readFinalizationClient(tx, this.schema, order)) !==
      prepared.clientRaw
    )
      throw new AccountWriteError(409, 'client_changed');
    if (
      countsWeeklyOrder(order) &&
      (await orderSetting(tx, this.schema, 'app')) !== prepared.weeklyRaw
    ) {
      throw new AccountWriteError(409, 'weekly_order_limit_changed');
    }
    await this.limits.assertFinalization(tx, actor, order, prepared.gate);
    return null;
  }
  private async weeklyCapacity(
    tx: SqlReader,
    order: Order,
    limit: number,
    week: string,
  ): Promise<void> {
    if (!countsWeeklyOrder(order) || limit === 0) return;
    const prefix =
      'SELECT COUNT(*) AS total FROM ' + this.schema + '.orders WHERE user_id=';
    const found = await tx.query(
      sqlQuery(
        'read',
        prefix +
          "? AND status='finalized' AND week_key=? AND (kind='accessories' OR (kind='combined' AND json_array_length(json_extract(payload,'$.items'))>0))",
        prefix +
          "$1 AND status='finalized' AND week_key=$2 AND (kind='accessories' OR (kind='combined' AND CASE WHEN jsonb_typeof(payload::jsonb->'items')='array' THEN jsonb_array_length(payload::jsonb->'items') ELSE 0 END>0))",
      ),
      [order.userId, week],
    );
    if (safeSqlInteger(found.rows[0].total) >= limit)
      throw new AccountWriteError(409, 'weekly_order_limit_reached');
  }
  private async discard(
    exports: OrderExportLifecycle,
    intent: OrderExportIntent,
    disposition: Exclude<ExportDisposition, 'committed'>,
  ): Promise<void> {
    try {
      if (intent.exportKey !== null) await exports.discard(intent);
      await exports.settle(intent, disposition);
    } catch (error) {
      throw new FinalizationReconciliationRequiredError(
        intent,
        'cleanup_pending',
        error,
      );
    }
  }
  async finalize(
    identity: RequestActorSnapshot,
    id: string,
    input: unknown,
    exports: OrderExportLifecycle,
  ): Promise<OrderFinalizationResult> {
    const captured = structuredClone(identity),
      body = structuredClone(input);
    const prepared = await this.database.read(async (tx) => {
      const actor = await requireOrderWriteActor(
        tx,
        this.schema,
        captured,
        this.clock,
      );
      const result = await this.preparation(tx, actor, id, body);
      await requireOrderWriteActor(tx, this.schema, captured, this.clock);
      return result;
    });
    if ('finalized' in prepared) return prepared;
    // Draft creation accepts any 36 hexadecimal/hyphen characters. Retain that
    // legacy domain and the existing case-insensitive stored-order behavior.
    // Neither separators nor dot segments can enter the private export key.
    if (!/^[0-9a-f-]{36}$/i.test(prepared.order.id)) {
      throw new Error('Stored order identity cannot bind a private export');
    }
    const operationId = randomUUID(),
      finalizedAt = new Date(accountClock(this.clock)).toISOString();
    const finalOrder = {
      ...prepared.order,
      status: 'finalized' as const,
      finalizedAt,
    };
    const exportKey =
      prepared.order.kind === 'stand_client'
        ? null
        : 'exports/' + prepared.order.id + '/' + operationId + '.xlsx';
    const intent: OrderExportIntent = Object.freeze({
      kind: 'order-finalization-v1',
      operationId,
      orderId: prepared.order.id,
      exportKey,
      draftRevision: prepared.order.revision,
      actorId: captured.userId,
      actorProfileVersion: captured.profileVersion,
      actorScopeRevision: captured.scopeRevision,
      draftPayloadSha256: orderInputHash(prepared.payloadRaw),
      finalOrderSha256: orderInputHash(JSON.stringify(finalOrder)),
      createdAt: finalizedAt,
    });
    try {
      await exports.begin(intent);
    } catch (error) {
      throw new FinalizationReconciliationRequiredError(
        intent,
        'journal_begin_unknown',
        error,
      );
    }
    // This second read follows durable journal acknowledgement and immediately
    // precedes staging. The final writer repeats it after its common lock.
    try {
      const winner = await this.database.read(async (tx) => {
        const actor = await requireOrderWriteActor(
          tx,
          this.schema,
          captured,
          this.clock,
        );
        const result = await this.assertInputs(tx, actor, prepared);
        await requireOrderWriteActor(tx, this.schema, captured, this.clock);
        return result;
      });
      if (winner) {
        await this.discard(exports, intent, 'concurrent_finalization');
        return {
          order: winner,
          finalized: false,
          exportKey: this.exportKey(winner),
        };
      }
    } catch (error) {
      if (!(error instanceof FinalizationReconciliationRequiredError))
        await this.discard(exports, intent, 'rolled_back');
      throw error;
    }
    if (exportKey !== null) {
      try {
        await exports.stage(
          intent,
          structuredClone(finalOrder),
          structuredClone(prepared.catalog),
        );
      } catch (error) {
        throw new FinalizationReconciliationRequiredError(
          intent,
          'export_stage_unknown',
          error,
        );
      }
    }
    let result: OrderFinalizationResult;
    try {
      result = await withCapturedOrderWrite(
        this.database,
        this.applicationSchema,
        captured,
        async (tx, actor) => {
          const winner = await this.assertInputs(tx, actor, prepared);
          if (winner)
            return {
              order: winner,
              finalized: false,
              exportKey: this.exportKey(winner),
            };
          const week = finalizationWeekKey(new Date(accountClock(this.clock)));
          await this.weeklyCapacity(
            tx,
            prepared.order,
            prepared.weeklyLimit,
            week,
          );
          for (const serial of prepared.order.serials) {
            const previous = await tx.query(
              sqlQuery(
                'read',
                'SELECT 1 AS used FROM ' +
                  this.schema +
                  '.serials WHERE serial=?',
                'SELECT 1 AS used FROM ' +
                  this.schema +
                  '.serials WHERE serial=$1',
              ),
              [serial],
            );
            if (previous.rows.length)
              throw new AccountWriteError(409, 'serial_already_finalized');
          }
          const payload = { ...finalOrder, exportKey: exportKey ?? undefined };
          const changed = await tx.query(
            sqlQuery(
              'write',
              'UPDATE ' +
                this.schema +
                ".orders SET status='finalized',finalized_at=?,week_key=?,payload=?,revision=revision+1 WHERE id=? AND status='draft' AND revision=?",
              'UPDATE ' +
                this.schema +
                ".orders SET status='finalized',finalized_at=$1,week_key=$2,payload=$3,revision=revision+1 WHERE id=$4 AND status='draft' AND revision=$5",
            ),
            [
              finalizedAt,
              week,
              JSON.stringify(payload),
              prepared.order.id,
              prepared.order.revision,
            ],
          );
          if (changed.changes !== 1)
            throw new AccountWriteError(409, 'order_changed');
          await this.limits.consumeFinalization(tx, prepared.gate, finalizedAt);
          for (const serial of prepared.order.serials)
            await tx.query(
              sqlQuery(
                'write',
                'INSERT INTO ' +
                  this.schema +
                  '.serials(serial,order_id) VALUES(?,?)',
                'INSERT INTO ' +
                  this.schema +
                  '.serials(serial,order_id) VALUES($1,$2)',
              ),
              [serial, prepared.order.id],
            );
          return {
            order: orderFromRow(
              await readOrderForWrite(
                tx,
                this.schema,
                prepared.order.id,
                actor,
              ),
            ),
            finalized: true,
            exportKey,
          };
        },
        this.clock,
      );
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError)
        throw new FinalizationReconciliationRequiredError(
          intent,
          'database_commit_unknown',
          error,
        );
      await this.discard(exports, intent, 'rolled_back');
      throw error;
    }
    if (!result.finalized) {
      await this.discard(exports, intent, 'concurrent_finalization');
      return result;
    }
    try {
      await exports.settle(intent, 'committed');
    } catch (error) {
      throw new FinalizationReconciliationRequiredError(
        intent,
        'journal_settle_pending',
        error,
      );
    }
    return result;
  }
}
