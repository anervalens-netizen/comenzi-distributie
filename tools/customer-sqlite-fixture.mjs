import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/** Native SQLite storage oracle; wholly synthetic rows are supplied by tests. */
export const customerSqliteObjects = Object.freeze([
  {
    type: 'table',
    name: 'customers',
    table: 'customers',
    sql: 'CREATE TABLE `customers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`warehouse_id` text NOT NULL,\n\t`data` text NOT NULL,\n\t`active` integer DEFAULT 1 NOT NULL\n)',
  },
  {
    type: 'index',
    name: 'idx_customers_warehouse',
    table: 'customers',
    sql: 'CREATE INDEX `idx_customers_warehouse` ON `customers` (`warehouse_id`)',
  },
  {
    type: 'table',
    name: 'partner_profiles',
    table: 'partner_profiles',
    sql: "CREATE TABLE partner_profiles (\n  customer_id TEXT PRIMARY KEY NOT NULL REFERENCES customers(id),\n  contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',\n  latitude REAL, longitude REAL, position_source TEXT, position_accuracy REAL, position_provider TEXT, position_metadata TEXT,\n  address_fingerprint TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,\n  updated_at TEXT NOT NULL, updated_by TEXT REFERENCES users(id),\n  CHECK ((latitude IS NULL AND longitude IS NULL AND position_source IS NULL AND position_accuracy IS NULL)\n    OR (latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90\n      AND longitude BETWEEN -180 AND 180 AND position_source IS NOT NULL AND position_source IN ('manual','gps','geocoding'))),\n  CHECK (position_accuracy IS NULL OR position_accuracy >= 0),\n  CHECK (position_source IS NOT 'geocoding' OR (position_provider IS NOT NULL AND position_metadata IS NOT NULL))\n)",
  },
  {
    type: 'index',
    name: 'idx_partner_profiles_coordinates',
    table: 'partner_profiles',
    sql: 'CREATE INDEX idx_partner_profiles_coordinates\n  ON partner_profiles(latitude, longitude, customer_id)',
  },
  {
    type: 'table',
    name: 'portfolio_revision',
    table: 'portfolio_revision',
    sql: 'CREATE TABLE portfolio_revision (id INTEGER PRIMARY KEY CHECK(id=1), data_revision INTEGER NOT NULL, scope_revision INTEGER NOT NULL)',
  },
  {
    type: 'table',
    name: 'portfolio_dirty',
    table: 'portfolio_dirty',
    sql: 'CREATE TABLE portfolio_dirty (id TEXT PRIMARY KEY NOT NULL)',
  },
  {
    type: 'table',
    name: 'location_county_overrides',
    table: 'location_county_overrides',
    sql: "CREATE TABLE location_county_overrides(\n      kind TEXT NOT NULL CHECK(kind IN ('customer','crm')),\n      id TEXT NOT NULL,county TEXT NOT NULL,PRIMARY KEY(kind,id))",
  },
  {
    type: 'table',
    name: 'customer_identity_aliases',
    table: 'customer_identity_aliases',
    sql: 'CREATE TABLE customer_identity_aliases(\n      alias_id TEXT PRIMARY KEY REFERENCES customers(id),\n      canonical_id TEXT NOT NULL REFERENCES customers(id),\n      original_data TEXT NOT NULL)',
  },
  {
    type: 'trigger',
    name: 'repair_customer_insert',
    table: 'customers',
    sql: "CREATE TRIGGER repair_customer_insert\n                AFTER INSERT ON customers\n                WHEN EXISTS(SELECT 1 FROM location_county_overrides WHERE kind='customer' AND id=NEW.id)\n                BEGIN UPDATE customers SET data=json_set(data,'$.county',(SELECT county FROM location_county_overrides WHERE kind='customer' AND id=NEW.id))\n                WHERE id=NEW.id AND json_extract(data,'$.county') IS NOT\n                (SELECT county FROM location_county_overrides WHERE kind='customer' AND id=NEW.id); END",
  },
  {
    type: 'trigger',
    name: 'repair_customer_update',
    table: 'customers',
    sql: "CREATE TRIGGER repair_customer_update\n                AFTER UPDATE ON customers\n                WHEN EXISTS(SELECT 1 FROM location_county_overrides WHERE kind='customer' AND id=NEW.id)\n                BEGIN UPDATE customers SET data=json_set(data,'$.county',(SELECT county FROM location_county_overrides WHERE kind='customer' AND id=NEW.id))\n                WHERE id=NEW.id AND json_extract(data,'$.county') IS NOT\n                (SELECT county FROM location_county_overrides WHERE kind='customer' AND id=NEW.id); END",
  },
  {
    type: 'trigger',
    name: 'repair_alias_active',
    table: 'customers',
    sql: 'CREATE TRIGGER repair_alias_active\n      AFTER UPDATE OF active ON customers\n      WHEN NEW.active!=0 AND EXISTS(SELECT 1 FROM customer_identity_aliases WHERE alias_id=NEW.id)\n      BEGIN UPDATE customers SET active=0 WHERE id=NEW.id; END',
  },
  {
    type: 'table',
    name: 'crm_directory_revision',
    table: 'crm_directory_revision',
    sql: 'CREATE TABLE crm_directory_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)',
  },
  {
    type: 'trigger',
    name: 'crm_directory_customers_insert',
    table: 'customers',
    sql: 'CREATE TRIGGER crm_directory_customers_insert AFTER INSERT ON customers BEGIN\n UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'crm_directory_customers_update',
    table: 'customers',
    sql: 'CREATE TRIGGER crm_directory_customers_update AFTER UPDATE ON customers BEGIN\n UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'crm_directory_customers_delete',
    table: 'customers',
    sql: 'CREATE TRIGGER crm_directory_customers_delete AFTER DELETE ON customers BEGIN\n UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'partner_profile_address_changed_v2',
    table: 'customers',
    sql: "CREATE TRIGGER partner_profile_address_changed_v2\nAFTER UPDATE OF data ON customers\nWHEN CASE WHEN json_valid(OLD.data) IS NOT 1 OR json_valid(NEW.data) IS NOT 1 THEN 1\n  ELSE COALESCE(json_extract(OLD.data,'$.address'),'') IS NOT COALESCE(json_extract(NEW.data,'$.address'),'')\n  OR COALESCE(json_extract(OLD.data,'$.city'),'') IS NOT COALESCE(json_extract(NEW.data,'$.city'),'')\n  OR COALESCE(json_extract(OLD.data,'$.county'),'') IS NOT COALESCE(json_extract(NEW.data,'$.county'),'') END\nBEGIN\n  UPDATE partner_profiles SET latitude=NULL,longitude=NULL,position_source=NULL,position_accuracy=NULL,\n    position_provider=NULL,position_metadata=NULL,address_fingerprint='',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=NULL\n  WHERE customer_id=NEW.id;\nEND",
  },
  {
    type: 'table',
    name: 'activation_portfolio_memberships',
    table: 'activation_portfolio_memberships',
    sql: 'CREATE TABLE activation_portfolio_memberships (\n  warehouse_id TEXT NOT NULL,\n  customer_id TEXT NOT NULL,\n  PRIMARY KEY (warehouse_id, customer_id)\n) WITHOUT ROWID',
  },
  {
    type: 'index',
    name: 'activation_memberships_customer',
    table: 'activation_portfolio_memberships',
    sql: 'CREATE INDEX activation_memberships_customer ON activation_portfolio_memberships(customer_id)',
  },
  {
    type: 'view',
    name: 'activation_customer_warehouse_rows',
    table: 'activation_customer_warehouse_rows',
    sql: "CREATE VIEW activation_customer_warehouse_rows AS\nSELECT DISTINCT c.id customer_id, w.value warehouse_id FROM customers c,\n  json_each(CASE\n    WHEN json_valid(c.data) IS NOT 1 THEN '[]'\n    WHEN json_type(c.data) <> 'object' THEN '[]'\n    WHEN COALESCE(json_type(c.data,'$.warehouseIds'),'null') = 'null' THEN json_array(c.warehouse_id)\n    WHEN json_type(c.data,'$.warehouseIds') = 'array' THEN json_extract(c.data,'$.warehouseIds')\n    ELSE '[]' END) w\nWHERE c.active=1 AND w.type='text'",
  },
  {
    type: 'trigger',
    name: 'activation_membership_insert',
    table: 'customers',
    sql: 'CREATE TRIGGER activation_membership_insert AFTER INSERT ON customers BEGIN\n  -- REPLACE can overwrite a row without firing its DELETE trigger.\n  DELETE FROM activation_portfolio_memberships WHERE customer_id=NEW.id;\n  INSERT INTO activation_portfolio_memberships(warehouse_id,customer_id)\n  SELECT warehouse_id,customer_id FROM activation_customer_warehouse_rows WHERE customer_id=NEW.id;\nEND',
  },
  {
    type: 'trigger',
    name: 'activation_membership_update',
    table: 'customers',
    sql: 'CREATE TRIGGER activation_membership_update AFTER UPDATE OF id, warehouse_id, data, active ON customers BEGIN\n  DELETE FROM activation_portfolio_memberships WHERE customer_id IN (OLD.id,NEW.id);\n  INSERT INTO activation_portfolio_memberships(warehouse_id,customer_id)\n  SELECT warehouse_id,customer_id FROM activation_customer_warehouse_rows WHERE customer_id=NEW.id;\nEND',
  },
  {
    type: 'trigger',
    name: 'activation_membership_delete',
    table: 'customers',
    sql: 'CREATE TRIGGER activation_membership_delete AFTER DELETE ON customers BEGIN\n  DELETE FROM activation_portfolio_memberships WHERE customer_id=OLD.id;\nEND',
  },
  {
    type: 'trigger',
    name: 'portfolio_dirty_customers_insert',
    table: 'customers',
    sql: 'CREATE TRIGGER portfolio_dirty_customers_insert AFTER INSERT ON customers BEGIN\n INSERT INTO portfolio_dirty SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.id);\n UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'portfolio_dirty_customers_update',
    table: 'customers',
    sql: 'CREATE TRIGGER portfolio_dirty_customers_update AFTER UPDATE ON customers BEGIN\n INSERT INTO portfolio_dirty SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.id);\n INSERT INTO portfolio_dirty SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.id);\n UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'portfolio_dirty_customers_delete',
    table: 'customers',
    sql: 'CREATE TRIGGER portfolio_dirty_customers_delete AFTER DELETE ON customers BEGIN\n INSERT INTO portfolio_dirty SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.id);\n UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'portfolio_dirty_partner_profiles_insert',
    table: 'partner_profiles',
    sql: 'CREATE TRIGGER portfolio_dirty_partner_profiles_insert AFTER INSERT ON partner_profiles BEGIN\n INSERT INTO portfolio_dirty SELECT NEW.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.customer_id);\n UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'portfolio_dirty_partner_profiles_update',
    table: 'partner_profiles',
    sql: 'CREATE TRIGGER portfolio_dirty_partner_profiles_update AFTER UPDATE ON partner_profiles BEGIN\n INSERT INTO portfolio_dirty SELECT OLD.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.customer_id);\n INSERT INTO portfolio_dirty SELECT NEW.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.customer_id);\n UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'trigger',
    name: 'portfolio_dirty_partner_profiles_delete',
    table: 'partner_profiles',
    sql: 'CREATE TRIGGER portfolio_dirty_partner_profiles_delete AFTER DELETE ON partner_profiles BEGIN\n INSERT INTO portfolio_dirty SELECT OLD.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.customer_id);\n UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;\nEND',
  },
  {
    type: 'index',
    name: 'idx_customers_consumer_candidates',
    table: 'customers',
    sql: "CREATE INDEX idx_customers_consumer_candidates\n  ON customers(CAST(json_extract(data,'$.cui') AS TEXT),id)\n  WHERE json_valid(data) AND CAST(json_extract(data,'$.cui') AS TEXT) GLOB '*[gG]*'\n    AND CAST(json_extract(data,'$.cui') AS TEXT) NOT GLOB '*[0-9]*'",
  },
]);

export function createCustomerSqliteOracle() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF;');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(
    db.prepare('PRAGMA recursive_triggers').get().recursive_triggers,
    0,
  );
  // Only the FK parent is needed here. The business writer contract will use
  // the complete authority fixture, not this storage-only stand-in.
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY NOT NULL); INSERT INTO users VALUES ('operator');",
  );
  for (const object of customerSqliteObjects) db.exec(object.sql);
  db.exec(
    'INSERT INTO portfolio_revision VALUES (1,100,200); INSERT INTO crm_directory_revision VALUES (1,300);',
  );
  const actual = db
    .prepare(
      "SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name<>'users' ORDER BY rowid",
    )
    .all();
  assert.deepEqual(
    actual.map((x) => ({
      type: x.type,
      name: x.name,
      table: x.table_name,
      sql: x.sql,
    })),
    customerSqliteObjects,
  );
  return db;
}

/** Storage-only transport. It does not stand in for application authorization. */
export function createNativeCustomerStorageFixture() {
  const db = createCustomerSqliteOracle();
  let savepoint = 0;
  const fixture = {
    dialect: 'sqlite',
    sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get()
      .version,
    tables: Object.fromEntries(
      customerSqliteObjects
        .filter((x) => x.type === 'table' || x.type === 'view')
        .map((x) => [x.name, `"${x.name}"`]),
    ),
    async run(sql, values = []) {
      const result = db.prepare(sql).run(...values);
      return { changes: Number(result.changes) };
    },
    async rows(sql, values = []) {
      return db
        .prepare(sql)
        .all(...values)
        .map((x) => ({ ...x }));
    },
    async atomic(action) {
      const name = `customer_contract_${++savepoint}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = await action(fixture);
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        try {
          db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Storage fixture rollback failed',
          );
        }
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
  return fixture;
}
