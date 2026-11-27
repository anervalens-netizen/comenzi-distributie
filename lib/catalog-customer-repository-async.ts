import { createHash } from 'node:crypto';
import { validEan } from './barcodes';
import { customerWarehouseValues } from './customer-membership-json';
import { productPhotoMime } from './product-photo';
import { AccountWriteError, accountClock, captureSessionIdentity,
  requireSessionInTransaction, type AccountRecord, type SessionIdentity } from './session-repository-async';
import { stockCode } from './stock-types';
import { sqlIdentifier, sqlQuery, type AsyncSqlDatabase, type SqlReader } from './sql-database';
import type { Client, Product, Warehouse } from './types';

export type CatalogState = { overrides: Record<string, Product | null> };
export type CatalogSnapshot = {
  raw: string | null; mappingsRaw: string | null; state: CatalogState;
  products: Product[]; mappings: Record<string, string>;
};

function checkedSchema(quotedSchema: string): string {
  if (typeof quotedSchema !== 'string' || !/^"[a-z][a-z0-9_]{0,62}"$/.test(quotedSchema)
    || sqlIdentifier(quotedSchema.slice(1, -1)) !== quotedSchema) throw new Error('Invalid quoted application schema');
  return quotedSchema;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid catalog or customer text');
  return value;
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Composable read: the caller owns the existing read OR writer transaction.
 * Raw values remain exact text for optimistic finalization/catalog predicates.
 * This helper opens no connection and does not nest a transaction.
 */
export async function readCatalogSnapshot(tx: SqlReader, quotedSchema: string,
  seedProducts: readonly Product[]): Promise<CatalogSnapshot> {
  const schema = checkedSchema(quotedSchema), seed = structuredClone(seedProducts);
  const result = await tx.query(sqlQuery('read',
    `SELECT value FROM ${schema}.settings WHERE key='catalog'`,
    `SELECT value FROM ${schema}.settings WHERE key='catalog'`));
  const raw = result.rows.length ? text(result.rows[0].value) : null;
  const state: CatalogState = raw !== null ? JSON.parse(raw) : { overrides: {} };
  const map = new Map(seed.map(product => [product.id, product]));
  for (const [id, product] of Object.entries(state.overrides)) {
    if (product) map.set(id, product); else map.delete(id);
  }
  const imported = await tx.query(sqlQuery('read',
    `SELECT value FROM ${schema}.settings WHERE key='inventory-ean-v1'`,
    `SELECT value FROM ${schema}.settings WHERE key='inventory-ean-v1'`));
  const mappingsRaw = imported.rows.length ? text(imported.rows[0].value) : null;
  const mappings: Record<string, string> = mappingsRaw !== null ? JSON.parse(mappingsRaw) : {};
  const products = [...map.values()].map(original => {
    const eans = original.ean !== undefined ? (original.ean ? [original.ean] : [])
      : Object.entries(mappings).filter(([, code]) => code === stockCode(original.code)).map(([ean]) => ean);
    if (original.ean === undefined && validEan(original.code) && !eans.includes(original.code)) eans.push(original.code);
    const product = { ...original, ean: eans[0] || '', eans };
    return { ...product, version: sha256(JSON.stringify(product)) };
  });
  return { raw, mappingsRaw, state, products, mappings };
}

export type CatalogCustomerSeed = Readonly<{ products: readonly Product[]; warehouses: readonly Warehouse[] }>;
export type CustomerRead = Client & { version?: string };

/** Prepared reads only. The production route and backend selector are separate. */
export class CatalogCustomerRepository {
  private readonly schema: string;
  private readonly seed: CatalogCustomerSeed;
  constructor(private readonly database: AsyncSqlDatabase, applicationSchema: string,
    seed: CatalogCustomerSeed, private readonly clock: () => number = Date.now) {
    this.schema = sqlIdentifier(applicationSchema); this.seed = structuredClone(seed);
  }
  private async user(tx: SqlReader, identity: SessionIdentity): Promise<AccountRecord> {
    const { user } = await requireSessionInTransaction(tx, this.schema, identity, accountClock(this.clock));
    if (user.mustChangePassword) throw new AccountWriteError(428, 'password_change_required');
    return user;
  }
  readCatalog(identity: SessionIdentity, admin = false): Promise<CatalogSnapshot> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const user = await this.user(tx, actor);
      if (admin && user.role !== 'manager') throw new AccountWriteError(403, 'manager_required');
      return readCatalogSnapshot(tx, this.schema, this.seed.products);
    });
  }
  readProductPhoto(identity: SessionIdentity, encodedId: string, filename: string): Promise<Response> {
    const actor = captureSessionIdentity(identity), key = 'catalog-photo:' + encodedId;
    return this.database.read(async tx => {
      await this.user(tx, actor);
      if (!/^[a-f0-9]{64}\.jpg$/.test(filename)) throw new AccountWriteError(404, 'product_photo_not_found');
      const binary = key.includes('\u0000');
      const result = await tx.query(sqlQuery('read',
        `SELECT substr(value,66) AS base64 FROM ${this.schema}.settings WHERE key=? AND substr(value,1,65)=?`,
        `SELECT substr(value,66) AS base64 FROM ${this.schema}.settings WHERE `
          + (binary ? "convert_to(key,'UTF8')=$1::bytea" : 'key=$1') + ' AND substr(value,1,65)=$2'),
      [tx.dialect === 'postgresql' && binary ? Buffer.from(key, 'utf8') : key, filename.slice(0, -4) + ':']);
      if (result.rows.length !== 1) throw new AccountWriteError(404, 'product_photo_not_found');
      return new Response(new Uint8Array(Buffer.from(text(result.rows[0].base64), 'base64')), { headers: {
        'Content-Type': productPhotoMime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      } });
    });
  }
  private async warehouseAllowed(tx: SqlReader, user: AccountRecord, warehouseId: string): Promise<boolean> {
    if (user.role === 'agent') return user.warehouseId === warehouseId;
    if (user.role === 'manager') return true; // Existing national READ scope only.
    const binary = warehouseId.includes('\u0000');
    const result = await tx.query(sqlQuery('read',
      `SELECT 1 AS allowed FROM ${this.schema}.manager_agents ma JOIN ${this.schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id=? LIMIT 1`,
      `SELECT 1 AS allowed FROM ${this.schema}.manager_agents ma JOIN ${this.schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=$1 AND `
        + (binary ? "convert_to(a.warehouse_id,'UTF8')=$2::bytea" : 'a.warehouse_id=$2') + ' LIMIT 1'),
    [user.id, tx.dialect === 'postgresql' && binary ? Buffer.from(warehouseId, 'utf8') : warehouseId]);
    return result.rows.length === 1;
  }
  listCustomers(identity: SessionIdentity, requestedWarehouseId: string | null): Promise<CustomerRead[]> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const user = await this.user(tx, actor);
      const warehouseId = user.role === 'agent' ? user.warehouseId : requestedWarehouseId;
      if (!warehouseId) throw new AccountWriteError(400, 'warehouse_required');
      if (!await this.warehouseAllowed(tx, user, warehouseId)) throw new AccountWriteError(404, 'warehouse_not_found');
      // Membership uses original JSON text. It must not pass through JSONB,
      // which would rewrite lexical numbers, keys and nested membership text.
      const rows = await tx.query(sqlQuery('read',
        `SELECT data,warehouse_id FROM ${this.schema}.customers WHERE active=1 ORDER BY id COLLATE BINARY`,
        `SELECT data,warehouse_id FROM ${this.schema}.customers WHERE active=1 ORDER BY id COLLATE "C"`));
      return rows.rows.flatMap(row => {
        const raw = text(row.data), fallback = row.warehouse_id === null ? null : text(row.warehouse_id);
        if (!customerWarehouseValues(raw, fallback).some(value => value === warehouseId)) return [];
        return [{ ...JSON.parse(raw), warehouseId, ...(user.role === 'manager' ? { version: sha256(raw) } : {}) } as CustomerRead];
      });
    });
  }
  visibleWarehouses(identity: SessionIdentity): Promise<Warehouse[]> {
    const actor = captureSessionIdentity(identity);
    return this.database.read(async tx => {
      const user = await this.user(tx, actor);
      if (user.role === 'agent') return structuredClone(this.seed.warehouses.filter(row => row.id === user.warehouseId));
      if (user.role === 'manager') return structuredClone([...this.seed.warehouses]);
      const rows = await tx.query(sqlQuery('read',
        `SELECT DISTINCT a.warehouse_id AS id FROM ${this.schema}.manager_agents ma JOIN ${this.schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=? AND a.warehouse_id IS NOT NULL`,
        `SELECT DISTINCT a.warehouse_id AS id FROM ${this.schema}.manager_agents ma JOIN ${this.schema}.users a ON a.id=ma.agent_id WHERE ma.manager_id=$1 AND a.warehouse_id IS NOT NULL`), [user.id]);
      const ids = new Set(rows.rows.map(row => text(row.id)));
      return structuredClone(this.seed.warehouses.filter(row => ids.has(row.id)));
    });
  }
}
