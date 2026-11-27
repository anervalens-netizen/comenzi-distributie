import {
  salesLocationKey,
  salesSiteKey,
  type SalesScope,
} from './sales-location';
import {
  safeSqlInteger,
  sqlIdentifier,
  sqlQuery,
  type SqlReader,
  type SqlValue,
} from './sql-database';
import {
  OrderUnavailableError,
  orderInputHash,
  orderSetting,
  orderText,
} from './order-finalization-state-async';

type ActorRow = {
  id: string;
  name: string;
  role: string;
  site_code: string | null;
  warehouse_name: string | null;
};
type SalesActor = {
  id: string;
  name: string;
  siteCode: string;
  warehouseName: string;
};
export type LimitMapping = Readonly<{
  scope: SalesScope | null;
  version: string;
  sourceStamp: string;
}>;
const aliasesKey = 'sales-agent-aliases-v1';
const nullableText = (value: unknown) =>
  value === null ? null : orderText(value);

/** Source identity reads stay on the caller's application/sales transaction. */
export class OrderLimitSources {
  private readonly application: string;
  private readonly sales: string;
  constructor(applicationSchema: string, salesSchema: string) {
    this.application = sqlIdentifier(applicationSchema);
    this.sales = sqlIdentifier(salesSchema);
  }
  private async mappingRows(
    tx: SqlReader,
  ): Promise<{
    rows: ActorRow[];
    aliasRaw: string | null;
    sourceStamp: string;
  }> {
    const select =
      'SELECT id,name,role,site_code,warehouse_name FROM ' +
      this.application +
      ".users WHERE active=1 AND (role='agent' OR (role='manager' AND TRIM(site_code)<>'')) ORDER BY ";
    const found = await tx.query(
      sqlQuery(
        'read',
        select + 'name,id',
        select + 'name COLLATE "C",id COLLATE "C"',
      ),
    );
    // Build these keys explicitly. Their JSON byte order is part of the current
    // mapping version; native driver's object enumeration is not the contract.
    const rows = found.rows.map((row) => ({
      id: orderText(row.id),
      name: orderText(row.name),
      role: orderText(row.role),
      site_code: nullableText(row.site_code),
      warehouse_name: nullableText(row.warehouse_name),
    }));
    const aliasRaw = await orderSetting(tx, this.application, aliasesKey);
    return { rows, aliasRaw, sourceStamp: JSON.stringify([rows, aliasRaw]) };
  }
  async mappingVersion(tx: SqlReader): Promise<string> {
    return orderInputHash((await this.mappingRows(tx)).sourceStamp);
  }
  async mapping(tx: SqlReader, agentId?: string): Promise<LimitMapping> {
    const { rows, aliasRaw, sourceStamp } = await this.mappingRows(tx);
    const actors: SalesActor[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      siteCode: row.site_code?.trim() || '',
      warehouseName:
        row.role === 'agent' ? row.warehouse_name?.trim() || '' : '',
    }));
    if (aliasRaw !== null) {
      let aliases: unknown;
      try {
        aliases = JSON.parse(aliasRaw);
      } catch {
        throw new OrderUnavailableError('invalid_sales_aliases');
      }
      if (!Array.isArray(aliases) || aliases.length > 1000)
        throw new OrderUnavailableError('invalid_sales_aliases');
      const current = new Map(actors.map((actor) => [actor.id, actor]));
      const identity = (actor: SalesActor) =>
        JSON.stringify([
          actor.id,
          salesSiteKey(actor.siteCode),
          salesLocationKey(actor.warehouseName),
        ]);
      const seen = new Set(actors.map(identity));
      for (const alias of aliases) {
        if (
          !alias ||
          typeof alias !== 'object' ||
          typeof alias.userId !== 'string' ||
          typeof alias.siteCode !== 'string' ||
          typeof alias.warehouseName !== 'string' ||
          alias.userId.length > 128 ||
          alias.siteCode.length > 80 ||
          alias.warehouseName.length > 200 ||
          !salesSiteKey(alias.siteCode) ||
          !salesLocationKey(alias.warehouseName)
        ) {
          throw new OrderUnavailableError('invalid_sales_aliases');
        }
        const owner = current.get(alias.userId);
        if (!owner) continue;
        const actor = {
          ...owner,
          siteCode: alias.siteCode.trim(),
          warehouseName: alias.warehouseName.trim(),
        };
        const key = identity(actor);
        if (!seen.has(key)) {
          seen.add(key);
          actors.push(actor);
        }
      }
    }
    const sites = new Map<string, SalesActor[]>(),
      locations = new Map<string, SalesActor[]>();
    for (const actor of actors) {
      for (const [key, index] of [
        [salesSiteKey(actor.siteCode), sites],
        [salesLocationKey(actor.warehouseName), locations],
      ] as const) {
        if (key) index.set(key, [...(index.get(key) || []), actor]);
      }
    }
    let scope: SalesScope | null = null;
    if (agentId) {
      const warehouseNames: string[] = [],
        warehouseSites: { warehouseName: string; siteCode: string }[] = [],
        siteCodes: string[] = [];
      let ambiguous = false;
      for (const actor of actors.filter((row) => row.id === agentId)) {
        if (actor.warehouseName) {
          if (
            locations.get(salesLocationKey(actor.warehouseName))?.length === 1
          )
            warehouseNames.push(actor.warehouseName);
          else if (
            !actor.siteCode ||
            sites.get(salesSiteKey(actor.siteCode))?.length !== 1
          )
            ambiguous = true;
          else
            warehouseSites.push({
              warehouseName: actor.warehouseName,
              siteCode: salesSiteKey(actor.siteCode),
            });
        } else if (actor.siteCode) {
          if (sites.get(salesSiteKey(actor.siteCode))?.length !== 1)
            ambiguous = true;
          else siteCodes.push(salesSiteKey(actor.siteCode));
        }
      }
      if (
        !ambiguous &&
        (warehouseNames.length || warehouseSites.length || siteCodes.length)
      ) {
        scope = {
          warehouseNames,
          warehouseSites,
          siteCodes,
          excludedWarehouseNames: [...locations]
            .filter(([, matches]) => matches.length === 1)
            .map(([key]) => key),
        };
      }
    }
    return { scope, sourceStamp, version: orderInputHash(sourceStamp) };
  }
  async version(tx: SqlReader, from: string, to: string): Promise<string> {
    const prefix =
      'SELECT month,import_id FROM ' +
      this.sales +
      '.sales_months WHERE month BETWEEN ';
    const rows = (
      await tx.query(
        sqlQuery(
          'read',
          prefix + '? AND ? ORDER BY month',
          prefix + '$1 AND $2 ORDER BY month COLLATE "C"',
        ),
        [from, to],
      )
    ).rows;
    return JSON.stringify([
      from,
      to,
      rows.map((row) => [orderText(row.month), safeSqlInteger(row.import_id)]),
    ]);
  }
  async totals(
    tx: SqlReader,
    scope: SalesScope | null,
    from: string,
    to: string,
    itemCodes: readonly string[],
  ) {
    const totals = new Map<string, number>();
    if (scope === null || !itemCodes.length)
      return { totals, coveredMonths: 0 };
    // The order evaluator supplies the reporting resolver's structured scope.
    if (typeof scope === 'string' || Array.isArray(scope))
      throw new Error('Structured order sales scope required');
    const locationQuery =
      'SELECT DISTINCT location FROM ' + this.sales + '.sales_rows';
    const rows = (
      await tx.query(sqlQuery('read', locationQuery, locationQuery))
    ).rows;
    const locations = new Map<string, string[]>();
    for (const row of rows) {
      const raw = orderText(row.location),
        key = salesLocationKey(raw);
      locations.set(key, [...(locations.get(key) || []), raw]);
    }
    const values: SqlValue[] = [from, to];
    const parameter = (value: SqlValue, dialect: 'sqlite' | 'postgresql') => {
      values.push(value);
      return dialect === 'sqlite' ? '?' : '$' + values.length;
    };
    const asciiCode = (value: string, dialect: 'sqlite' | 'postgresql') =>
      dialect === 'sqlite'
        ? 'UPPER(TRIM(' + value + '))'
        : 'translate(btrim(' +
          value +
          ", ' '),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ')";
    const build = (dialect: 'sqlite' | 'postgresql') => {
      values.splice(2);
      const member = (
        expr: string,
        entries: readonly string[],
        exclude = false,
      ) => {
        const param = parameter(JSON.stringify(entries), dialect);
        return (
          expr +
          (exclude ? ' NOT IN ' : ' IN ') +
          (dialect === 'sqlite'
            ? '(SELECT value FROM json_each(' + param + '))'
            : '(SELECT value FROM jsonb_array_elements_text(' +
              param +
              '::jsonb) AS items(value))')
        );
      };
      const locationFilter = (names: readonly string[], exclude = false) => {
        const aliases = [...new Set(names.map(salesLocationKey))].flatMap(
          (name) => locations.get(name) || [],
        );
        return aliases.length
          ? member('r.location', aliases, exclude)
          : exclude
            ? '1=1'
            : '1=0';
      };
      const clauses: string[] = [];
      if (scope.warehouseNames.length)
        clauses.push(locationFilter(scope.warehouseNames));
      for (const pair of scope.warehouseSites || []) {
        clauses.push(
          '(' +
            locationFilter([pair.warehouseName]) +
            ' AND ' +
            asciiCode('r.site_code', dialect) +
            '=' +
            parameter(salesSiteKey(pair.siteCode), dialect) +
            ')',
        );
      }
      if (scope.siteCodes.length) {
        let fallback = member(
          asciiCode('r.site_code', dialect),
          scope.siteCodes,
        );
        if (scope.excludedWarehouseNames.length)
          fallback +=
            ' AND ' + locationFilter(scope.excludedWarehouseNames, true);
        clauses.push('(' + fallback + ')');
      }
      let filter = '(' + (clauses.join(' OR ') || '1=0') + ')';
      if (scope.siteCode)
        filter +=
          ' AND ' +
          asciiCode('r.site_code', dialect) +
          '=' +
          asciiCode(parameter(scope.siteCode, dialect), dialect);
      const code = asciiCode('r.item_code', dialect);
      return (
        'SELECT ' +
        code +
        ' AS code,SUM(r.quantity) AS quantity FROM ' +
        this.sales +
        '.sales_rows r JOIN ' +
        this.sales +
        '.sales_months active ON active.import_id=r.import_id AND active.month=r.month WHERE r.month BETWEEN ' +
        (dialect === 'sqlite' ? '? AND ?' : '$1 AND $2') +
        ' AND ' +
        filter +
        ' AND ' +
        member(code, itemCodes) +
        ' GROUP BY ' +
        code
      );
    };
    const sqlite = build('sqlite'),
      sqliteValues = [...values],
      postgresql = build('postgresql');
    if (JSON.stringify(sqliteValues) !== JSON.stringify(values))
      throw new Error('Dialect parameter order differs');
    for (const row of (
      await tx.query(sqlQuery('read', sqlite, postgresql), values)
    ).rows) {
      const quantity = Number(row.quantity);
      if (Number.isFinite(quantity)) totals.set(orderText(row.code), quantity);
    }
    const count = await tx.query(
      sqlQuery(
        'read',
        'SELECT COUNT(*) AS total FROM ' +
          this.sales +
          '.sales_months WHERE month BETWEEN ? AND ?',
        'SELECT COUNT(*) AS total FROM ' +
          this.sales +
          '.sales_months WHERE month BETWEEN $1 AND $2',
      ),
      [from, to],
    );
    return { totals, coveredMonths: safeSqlInteger(count.rows[0].total) };
  }
}
