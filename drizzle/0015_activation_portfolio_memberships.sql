-- Rebuild only the derived membership schema. Node checks its definitions
-- before applying this file and holds a single write transaction through repair.
DROP TRIGGER IF EXISTS activation_membership_insert;
DROP TRIGGER IF EXISTS activation_membership_update;
DROP TRIGGER IF EXISTS activation_membership_delete;
DROP VIEW IF EXISTS activation_customer_warehouse_rows;
DROP TABLE IF EXISTS activation_portfolio_memberships;
CREATE TABLE activation_portfolio_memberships (
  warehouse_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  PRIMARY KEY (warehouse_id, customer_id)
) WITHOUT ROWID;
CREATE INDEX activation_memberships_customer ON activation_portfolio_memberships(customer_id);
-- An unreadable customer never inherits its warehouse as an authorization fallback.
-- Legacy objects without an explicit membership array retain their warehouse.
CREATE VIEW activation_customer_warehouse_rows AS
SELECT DISTINCT c.id customer_id, w.value warehouse_id FROM customers c,
  json_each(CASE
    WHEN json_valid(c.data) IS NOT 1 THEN '[]'
    WHEN json_type(c.data) <> 'object' THEN '[]'
    WHEN COALESCE(json_type(c.data,'$.warehouseIds'),'null') = 'null' THEN json_array(c.warehouse_id)
    WHEN json_type(c.data,'$.warehouseIds') = 'array' THEN json_extract(c.data,'$.warehouseIds')
    ELSE '[]' END) w
WHERE c.active=1 AND w.type='text';
INSERT INTO activation_portfolio_memberships(warehouse_id,customer_id)
SELECT warehouse_id,customer_id FROM activation_customer_warehouse_rows;
CREATE TRIGGER activation_membership_insert AFTER INSERT ON customers BEGIN
  -- REPLACE can overwrite a row without firing its DELETE trigger.
  DELETE FROM activation_portfolio_memberships WHERE customer_id=NEW.id;
  INSERT INTO activation_portfolio_memberships(warehouse_id,customer_id)
  SELECT warehouse_id,customer_id FROM activation_customer_warehouse_rows WHERE customer_id=NEW.id;
END;
CREATE TRIGGER activation_membership_update AFTER UPDATE OF id, warehouse_id, data, active ON customers BEGIN
  DELETE FROM activation_portfolio_memberships WHERE customer_id IN (OLD.id,NEW.id);
  INSERT INTO activation_portfolio_memberships(warehouse_id,customer_id)
  SELECT warehouse_id,customer_id FROM activation_customer_warehouse_rows WHERE customer_id=NEW.id;
END;
CREATE TRIGGER activation_membership_delete AFTER DELETE ON customers BEGIN
  DELETE FROM activation_portfolio_memberships WHERE customer_id=OLD.id;
END;
