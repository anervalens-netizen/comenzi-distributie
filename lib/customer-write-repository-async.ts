import { createHash } from 'node:crypto';
import type { RequestActorSnapshot } from './authority-repository-async';
import type { ClientImportPreview } from './client-import-server';
import { customerWarehouseValues } from './customer-membership-json';
import {
  orderAgentAllowed,
  withCapturedOrderWrite,
} from './order-write-authority-async';
import { normalizeCui, partnerPointKey } from './partner-identity';
import type { AccountRecord } from './session-repository-async';
import {
  safeSqlInteger,
  sqlIdentifier,
  sqlQuery,
  type AsyncSqlDatabase,
  type SqlReader,
  type SqlRow,
  type SqlWriter,
} from './sql-database';
import type { Client, User, Warehouse } from './types';
import { readUsersWithClientCounts } from './user-read-repository-async';

type CustomerRow = {
  id: string;
  warehouse_id: string;
  data: string;
  active: number;
};
type ImportResult =
  | { preview: ClientImportPreview }
  | { count: number; users: User[] };
type EditResult = { client: Client & { version: string }; users: User[] };

export class CustomerWriteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'CustomerWriteError';
  }
}
function fail(status: CustomerWriteError['status'], message: string): never {
  throw new CustomerWriteError(status, message);
}
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const textField = (value: unknown, max = 500) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Invalid stored customer text');
  return value;
}
function capturedBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    fail(400, 'Date invalide.');
  // HTTP has already parsed JSON. Retain that snapshot across every await.
  return structuredClone(body);
}
function requireManager(user: AccountRecord): void {
  if (user.role !== 'manager')
    fail(403, 'Această acțiune este disponibilă managerului.');
}
function customerRow(row: SqlRow): CustomerRow {
  // Property order is part of the existing preview SHA input.
  return {
    id: text(row.id),
    warehouse_id: text(row.warehouse_id),
    data: text(row.data),
    active: safeSqlInteger(row.active),
  };
}
async function requireWarehouse(
  tx: SqlReader,
  schema: string,
  user: AccountRecord,
  id: string,
): Promise<void> {
  if (user.role === 'manager' && user.managerScope === 'global') return;
  const rows = await tx.query(
    sqlQuery(
      'read',
      `SELECT 1 AS allowed FROM ${schema}.manager_agents ma JOIN ${schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id=? LIMIT 1`,
      `SELECT 1 AS allowed FROM ${schema}.manager_agents ma JOIN ${schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=$1 AND a.warehouse_id=$2 LIMIT 1`,
    ),
    [user.id, id],
  );
  if (!rows.rows.length) fail(404, 'Gestiunea nu a fost găsită.');
}

/**
 * The caller owns the transaction. Ordering and every raw field are retained.
 * The lexical helper is the already qualified SQLite JSON1 membership rule,
 * including first duplicate keys and SQL value types. Eligibility is explicit.
 * This initially scans the coherent customer snapshot; a future SQL/index
 * optimization must retain the same scope and measured ordering contract.
 */
async function importScope(
  tx: SqlReader,
  schema: string,
  warehouseId: string,
  incomingIds: ReadonlySet<string>,
): Promise<CustomerRow[]> {
  const result = await tx.query(
    sqlQuery(
      'read',
      `SELECT id,warehouse_id,data,active FROM ${schema}.customers ORDER BY id COLLATE BINARY`,
      `SELECT id,warehouse_id,data,active FROM ${schema}.customers ORDER BY id COLLATE "C"`,
    ),
  );
  return result.rows
    .map(customerRow)
    .filter(
      (row) =>
        row.warehouse_id === warehouseId ||
        customerWarehouseValues(row.data, row.warehouse_id).includes(
          warehouseId,
        ) ||
        incomingIds.has(row.id),
    );
}
function sameSnapshot(
  actual: readonly CustomerRow[],
  expected: ReadonlyMap<string, CustomerRow>,
): boolean {
  if (actual.length !== expected.size) return false;
  return actual.every((row) => {
    const wanted = expected.get(row.id);
    return (
      wanted !== undefined &&
      row.warehouse_id === wanted.warehouse_id &&
      row.data === wanted.data &&
      row.active === wanted.active
    );
  });
}
const identity = (client: Client) =>
  `${normalizeCui(client.cui)}|${partnerPointKey(client.city, client.county || '', client.address || '')}`;
const editInstruction =
  'Identitate ambiguă: editează mai întâi adresa clientului cunoscut din Echipă → portofoliul agentului, apoi reimportă. Pentru un punct nou al aceleiași firme, păstrează în fișier identitățile exacte ale punctelor existente.';
const changedSnapshot =
  'Portofoliul s-a modificat între timp. Reîncarcă previzualizarea; importul nu a fost aplicat.';

/**
 * Closed manager edit/import flows. All authority reads, business reads, writes
 * and response reads use the dedicated client acquired by database.write.
 * No runtime singleton, selector, nested transaction, background task or I/O.
 */
export class CustomerWriteRepository {
  private readonly schema: string;
  private readonly warehouses: readonly Warehouse[];
  constructor(
    private readonly database: AsyncSqlDatabase,
    private readonly applicationSchema: string,
    warehouses: readonly Warehouse[],
    private readonly clock: () => number = Date.now,
  ) {
    this.schema = sqlIdentifier(applicationSchema);
    this.warehouses = Object.freeze(
      warehouses.map((item) =>
        Object.freeze({ id: text(item.id), name: text(item.name) }),
      ),
    );
  }

  edit(
    actor: RequestActorSnapshot,
    customerId: string,
    input: Record<string, unknown>,
  ): Promise<EditResult> {
    const body = capturedBody(input),
      id = text(customerId);
    return withCapturedOrderWrite(
      this.database,
      this.applicationSchema,
      actor,
      async (tx, user) => {
        requireManager(user);
        const result = await tx.query(
          sqlQuery(
            'read',
            `SELECT data,warehouse_id FROM ${this.schema}.customers WHERE id=? AND active=1`,
            `SELECT data,warehouse_id FROM ${this.schema}.customers WHERE id=$1 AND active=1`,
          ),
          [id],
        );
        if (result.rows.length !== 1)
          fail(
            404,
            'Clientul nu mai este în portofoliul activ. Actualizează lista.',
          );
        const row = result.rows[0],
          raw = text(row.data),
          warehouse = text(row.warehouse_id);
        const original = JSON.parse(raw) as Client;
        const oldWarehouses = original.warehouseIds || [warehouse];
        const sourceWarehouseId =
          textField(body.sourceWarehouseId) || warehouse;
        if (!oldWarehouses.includes(sourceWarehouseId))
          fail(400, 'Gestiunea sursă nu aparține clientului.');
        await requireWarehouse(tx, this.schema, user, sourceWarehouseId);
        if (body.version !== sha256(raw))
          fail(
            409,
            'Clientul a fost modificat între timp. Reîncarcă portofoliul înainte de editare.',
          );
        const ids =
          body.agentIds === undefined
            ? [textField(body.agentId)]
            : body.agentIds;
        if (Array.isArray(ids))
          for (const agentId of ids)
            if (
              typeof agentId === 'string' &&
              !(await orderAgentAllowed(tx, this.schema, user, agentId))
            )
              fail(404, 'Agentul nu a fost găsit.');
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 50 ||
          ids.some((agentId) => typeof agentId !== 'string')
        ) {
          fail(400, 'Selectează cel puțin un agent.');
        }
        const agents = await tx.query(
          sqlQuery(
            'read',
            `SELECT id,warehouse_id,active FROM ${this.schema}.users WHERE role='agent'`,
            `SELECT id,warehouse_id,active FROM ${this.schema}.users WHERE role='agent'`,
          ),
        );
        const selected = ids.map((agentId) =>
          agents.rows.find((agent) => agent.id === agentId),
        );
        if (
          selected.some(
            (agent) =>
              !agent?.warehouse_id ||
              (!safeSqlInteger(agent.active) &&
                !oldWarehouses.includes(text(agent.warehouse_id))),
          )
        ) {
          fail(400, 'Alege agenți activi pentru portofoliu.');
        }
        const selectedWarehouses = selected.map((agent) =>
          text(agent!.warehouse_id),
        );
        let warehouseIds: string[];
        if (user.managerScope === 'global') {
          warehouseIds = [
            ...new Set(
              body.agentIds === undefined
                ? [
                    ...oldWarehouses.filter(
                      (value) => value !== sourceWarehouseId,
                    ),
                    selectedWarehouses[0],
                  ]
                : selectedWarehouses,
            ),
          ];
        } else {
          const scoped = await tx.query(
            sqlQuery(
              'read',
              `SELECT DISTINCT a.warehouse_id FROM ${this.schema}.manager_agents ma JOIN ${this.schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id IS NOT NULL`,
              `SELECT DISTINCT a.warehouse_id FROM ${this.schema}.manager_agents ma JOIN ${this.schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=$1 AND a.warehouse_id IS NOT NULL`,
            ),
            [user.id],
          );
          const visible = new Set(
            scoped.rows.map((item) => text(item.warehouse_id)),
          );
          warehouseIds = [
            ...new Set([
              ...oldWarehouses.filter((value) => !visible.has(value)),
              ...selectedWarehouses,
            ]),
          ];
        }
        const limits = {
          name: 200,
          cui: 40,
          city: 100,
          county: 100,
          address: 500,
          route: 30,
        } as const;
        const values: Record<string, string> = {};
        for (const [key, limit] of Object.entries(limits)) {
          const value = body[key];
          if (typeof value !== 'string' || value.length > limit)
            fail(400, 'Datele clientului sunt invalide sau prea lungi.');
          values[key] = value.trim();
        }
        if (!values.name || !values.cui || !values.city)
          fail(400, 'Denumirea, CUI-ul și localitatea sunt obligatorii.');
        const client = {
          ...original,
          ...values,
          warehouseId: warehouseIds[0],
          warehouseIds,
        };
        const data = JSON.stringify(client);
        const written = await tx.query(
          sqlQuery(
            'write',
            `UPDATE ${this.schema}.customers SET data=?,warehouse_id=? WHERE id=? AND active=1 AND data=? AND warehouse_id=?`,
            `UPDATE ${this.schema}.customers SET data=$1,warehouse_id=$2 WHERE id=$3 AND active=1 AND data=$4 AND warehouse_id=$5`,
          ),
          [data, warehouseIds[0], id, raw, warehouse],
        );
        if (written.changes !== 1)
          fail(
            409,
            'Clientul s-a modificat între timp. Reîncarcă portofoliul.',
          );
        // Preserve the current HTTP response: its version hashes the prepared raw
        // text, even when an installed county trigger subsequently repairs it.
        return {
          client: { ...client, version: sha256(data) },
          users: await readUsersWithClientCounts(
            tx,
            this.schema,
            user,
            this.warehouses,
          ),
        };
      },
      this.clock,
    );
  }

  importClients(
    actor: RequestActorSnapshot,
    input: Record<string, unknown>,
  ): Promise<ImportResult> {
    const body = capturedBody(input),
      warehouseId = textField(body.warehouseId);
    return withCapturedOrderWrite(
      this.database,
      this.applicationSchema,
      actor,
      async (tx, user) => {
        requireManager(user);
        if (!this.warehouses.some((warehouse) => warehouse.id === warehouseId))
          fail(400, 'Gestiune invalidă.');
        await requireWarehouse(tx, this.schema, user, warehouseId);
        const result = await this.applyImport(tx, warehouseId, body);
        return 'preview' in result
          ? result
          : {
              ...result,
              users: await readUsersWithClientCounts(
                tx,
                this.schema,
                user,
                this.warehouses,
              ),
            };
      },
      this.clock,
    );
  }

  private async applyImport(
    tx: SqlWriter,
    warehouseId: string,
    body: Record<string, unknown>,
  ): Promise<{ preview: ClientImportPreview } | { count: number }> {
    if (
      !Array.isArray(body.clients) ||
      !body.clients.length ||
      body.clients.length > 3000
    )
      fail(400, 'Importul acceptă între 1 și 3.000 de clienți.');
    const incoming: Client[] = [],
      seen = new Set<string>();
    for (const raw of body.clients) {
      if (!raw || typeof raw !== 'object') fail(400, 'Client invalid.');
      const value = raw as Record<string, unknown>;
      const client: Client = {
        id: '',
        warehouseId,
        name: textField(value.name, 200),
        cui: textField(value.cui, 40),
        city: textField(value.city, 100),
        county: textField(value.county, 100),
        address: textField(value.address, 500),
        route: textField(value.route, 30),
      };
      if (!client.name || !normalizeCui(client.cui) || !client.city)
        fail(
          400,
          'Fiecare client trebuie să aibă denumire, CUI și localitate.',
        );
      const key = identity(client);
      if (seen.has(key)) continue;
      seen.add(key);
      client.id = 'imp-' + sha256(`${warehouseId}|${key}`).slice(0, 32);
      incoming.push(client);
    }
    const ids = new Set(incoming.map((client) => client.id));
    const rows = await importScope(tx, this.schema, warehouseId, ids);
    const owned = rows.filter((row) => row.warehouse_id === warehouseId);
    const parsed = new Map(
      rows.map((row) => [row.id, JSON.parse(row.data) as Client]),
    );
    const byIdentity = new Map<string, CustomerRow[]>();
    for (const row of owned) {
      const key = identity(parsed.get(row.id)!);
      byIdentity.set(key, [...(byIdentity.get(key) || []), row]);
    }
    const preview: ClientImportPreview = {
      snapshot: sha256(JSON.stringify([warehouseId, incoming, rows])),
      removed: [],
      added: [],
      unchanged: [],
      ambiguous: [],
      blocked: [],
    };
    if (
      rows.some(
        (row) =>
          (parsed.get(row.id)!.warehouseIds || [row.warehouse_id]).length > 1 &&
          (row.active === 1 || seen.has(identity(parsed.get(row.id)!))),
      )
    ) {
      preview.blocked.push(
        'Portofoliul conține puncte comune. Editează atribuirile din Echipă; importul individual nu poate înlocui un portofoliu partajat.',
      );
    }
    const records: Client[] = [];
    for (const client of incoming) {
      const matches = byIdentity.get(identity(client)) || [];
      if (matches.length > 1) {
        preview.ambiguous.push(client);
        continue;
      }
      if (matches.length === 1) {
        const row = matches[0],
          original = parsed.get(row.id)!;
        const values = Object.fromEntries(
          Object.entries(client).filter(
            ([key, value]) =>
              !['id', 'warehouseId', 'address', 'city', 'county'].includes(
                key,
              ) && value !== '',
          ),
        );
        const record = { ...original, ...values, id: row.id } as Client;
        records.push(record);
        preview.unchanged.push(record);
      } else {
        const firm = owned.filter(
          (row) =>
            normalizeCui(parsed.get(row.id)!.cui) === normalizeCui(client.cui),
        );
        if (
          firm.some(
            (row) =>
              row.active === 1 && !seen.has(identity(parsed.get(row.id)!)),
          ) ||
          (firm.length > 0 && !client.address)
        ) {
          preview.ambiguous.push(client);
          continue;
        }
        if (rows.some((row) => row.id === client.id))
          preview.blocked.push(
            'Un client din import a fost mutat sau partajat. Verifică atribuirile din Echipă.',
          );
        records.push(client);
        preview.added.push(client);
      }
    }
    const retained = new Set(records.map((client) => client.id));
    preview.removed = owned
      .filter((row) => row.active === 1 && !retained.has(row.id))
      .map((row) => ({ ...parsed.get(row.id)!, id: row.id }));
    if (preview.ambiguous.length) preview.blocked.push(editInstruction);
    if (body.preview === true) return { preview };
    if (preview.blocked.length) fail(409, preview.blocked.join(' '));
    if (
      (rows.length > 0 || body.snapshot !== undefined) &&
      body.snapshot !== preview.snapshot
    ) {
      fail(
        409,
        'Portofoliul s-a modificat sau lipsește previzualizarea. Reîncarcă previzualizarea; importul nu a fost aplicat.',
      );
    }
    if (preview.removed.length && body.confirmRemovals !== preview.snapshot)
      fail(
        409,
        'Confirmă explicit eliminarea punctelor lipsă din această previzualizare.',
      );
    const expected = new Map(rows.map((row) => [row.id, { ...row }]));
    for (const client of preview.removed) expected.get(client.id)!.active = 0;
    for (const client of records)
      expected.set(client.id, {
        id: client.id,
        warehouse_id: warehouseId,
        data: JSON.stringify(client),
        active: 1,
      });
    // The writer gate was acquired before the initial authority/scope read.
    // Recheck the complete raw set just before mutation, preserving the original
    // whole-set guard rather than replacing it with per-row upserts alone.
    if (
      !sameSnapshot(
        await importScope(tx, this.schema, warehouseId, ids),
        new Map(rows.map((row) => [row.id, row])),
      )
    )
      fail(409, changedSnapshot);
    for (const client of preview.removed) {
      const removed = await tx.query(
        sqlQuery(
          'write',
          `UPDATE ${this.schema}.customers SET active=0 WHERE id=?`,
          `UPDATE ${this.schema}.customers SET active=0 WHERE id=$1`,
        ),
        [client.id],
      );
      if (removed.changes !== 1) fail(409, changedSnapshot);
    }
    for (const client of records) {
      const old = rows.find((row) => row.id === client.id);
      const result = await tx.query(
        sqlQuery(
          'write',
          `INSERT INTO ${this.schema}.customers(id,warehouse_id,data,active) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=1 WHERE customers.warehouse_id=excluded.warehouse_id AND customers.data=? AND customers.active=?`,
          `INSERT INTO ${this.schema}.customers(id,warehouse_id,data,active) VALUES($1,$2,$3,1) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=1 WHERE customers.warehouse_id=excluded.warehouse_id AND customers.data=$4 AND customers.active=$5`,
        ),
        [
          client.id,
          warehouseId,
          JSON.stringify(client),
          old?.data ?? '',
          old?.active ?? 0,
        ],
      );
      if (result.changes !== 1) fail(409, changedSnapshot);
    }
    if (
      !sameSnapshot(
        await importScope(tx, this.schema, warehouseId, ids),
        expected,
      )
    )
      fail(409, changedSnapshot);
    return { count: records.length };
  }
}
