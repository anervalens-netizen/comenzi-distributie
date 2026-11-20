-- Rebuildable index over the same JSON memberships as the portfolio.
-- Boot executes the backfill and installs the triggers in one transaction.
CREATE TABLE activation_portfolio_memberships (
  warehouse_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  PRIMARY KEY (warehouse_id, customer_id)
) WITHOUT ROWID;
CREATE INDEX activation_memberships_customer ON activation_portfolio_memberships(customer_id);
INSERT INTO activation_portfolio_memberships
SELECT DISTINCT w.value, c.id FROM customers c,
  json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w
WHERE c.active=1 AND w.type='text';
CREATE TRIGGER activation_membership_insert AFTER INSERT ON customers BEGIN
  -- REPLACE can overwrite a row without firing its DELETE trigger.
  DELETE FROM activation_portfolio_memberships WHERE customer_id=NEW.id;
  INSERT INTO activation_portfolio_memberships
  SELECT DISTINCT w.value, NEW.id FROM json_each(COALESCE(json_extract(NEW.data,'$.warehouseIds'),json_array(NEW.warehouse_id))) w
  WHERE NEW.active=1 AND w.type='text';
END;
CREATE TRIGGER activation_membership_update AFTER UPDATE OF id, warehouse_id, data, active ON customers BEGIN
  DELETE FROM activation_portfolio_memberships WHERE customer_id IN (OLD.id,NEW.id);
  INSERT INTO activation_portfolio_memberships
  SELECT DISTINCT w.value, NEW.id FROM json_each(COALESCE(json_extract(NEW.data,'$.warehouseIds'),json_array(NEW.warehouse_id))) w
  WHERE NEW.active=1 AND w.type='text';
END;
CREATE TRIGGER activation_membership_delete AFTER DELETE ON customers BEGIN
  DELETE FROM activation_portfolio_memberships WHERE customer_id=OLD.id;
END;
