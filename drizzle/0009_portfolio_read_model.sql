-- Derived, rebuildable projection; authoritative customer/profile rows are untouched.
CREATE TABLE IF NOT EXISTS portfolio_revision (id INTEGER PRIMARY KEY CHECK(id=1), data_revision INTEGER NOT NULL, scope_revision INTEGER NOT NULL);
INSERT OR IGNORE INTO portfolio_revision VALUES(1,1,1);
CREATE TABLE IF NOT EXISTS portfolio_dirty (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE IF NOT EXISTS portfolio_read_rows (id TEXT PRIMARY KEY NOT NULL, summary TEXT NOT NULL, name TEXT, search TEXT NOT NULL, city_search TEXT NOT NULL, county TEXT, city TEXT, route TEXT, latitude REAL, longitude REAL, position_source TEXT, last_visited_at TEXT);
CREATE INDEX IF NOT EXISTS idx_portfolio_read_name ON portfolio_read_rows(name,id);
CREATE INDEX IF NOT EXISTS idx_portfolio_read_county ON portfolio_read_rows(county,city,route);
CREATE INDEX IF NOT EXISTS idx_portfolio_read_coordinates ON portfolio_read_rows(latitude,longitude);
CREATE INDEX IF NOT EXISTS idx_portfolio_read_visits ON portfolio_read_rows(last_visited_at);
CREATE TABLE IF NOT EXISTS portfolio_model_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
DROP TRIGGER IF EXISTS portfolio_dirty_customers_insert;
CREATE TRIGGER portfolio_dirty_customers_insert AFTER INSERT ON customers BEGIN
 INSERT INTO portfolio_dirty SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_customers_update;
CREATE TRIGGER portfolio_dirty_customers_update AFTER UPDATE ON customers BEGIN
 INSERT INTO portfolio_dirty SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.id);
 INSERT INTO portfolio_dirty SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_customers_delete;
CREATE TRIGGER portfolio_dirty_customers_delete AFTER DELETE ON customers BEGIN
 INSERT INTO portfolio_dirty SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_partner_profiles_insert;
CREATE TRIGGER portfolio_dirty_partner_profiles_insert AFTER INSERT ON partner_profiles BEGIN
 INSERT INTO portfolio_dirty SELECT NEW.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.customer_id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_partner_profiles_update;
CREATE TRIGGER portfolio_dirty_partner_profiles_update AFTER UPDATE ON partner_profiles BEGIN
 INSERT INTO portfolio_dirty SELECT OLD.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.customer_id);
 INSERT INTO portfolio_dirty SELECT NEW.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.customer_id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_partner_profiles_delete;
CREATE TRIGGER portfolio_dirty_partner_profiles_delete AFTER DELETE ON partner_profiles BEGIN
 INSERT INTO portfolio_dirty SELECT OLD.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.customer_id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_partner_visits_insert;
CREATE TRIGGER portfolio_dirty_partner_visits_insert AFTER INSERT ON partner_visits BEGIN
 INSERT INTO portfolio_dirty SELECT NEW.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.customer_id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_partner_visits_update;
CREATE TRIGGER portfolio_dirty_partner_visits_update AFTER UPDATE ON partner_visits BEGIN
 INSERT INTO portfolio_dirty SELECT OLD.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.customer_id);
 INSERT INTO portfolio_dirty SELECT NEW.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=NEW.customer_id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS portfolio_dirty_partner_visits_delete;
CREATE TRIGGER portfolio_dirty_partner_visits_delete AFTER DELETE ON partner_visits BEGIN
 INSERT INTO portfolio_dirty SELECT OLD.customer_id WHERE NOT EXISTS (SELECT 1 FROM portfolio_dirty WHERE id=OLD.customer_id);
 UPDATE portfolio_revision SET data_revision=data_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS portfolio_scope_users_insert AFTER INSERT ON users BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS portfolio_scope_users_update AFTER UPDATE OF warehouse_id,active,role,manager_scope ON users BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS portfolio_scope_users_delete AFTER DELETE ON users BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS portfolio_scope_manager_agents_insert AFTER INSERT ON manager_agents BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS portfolio_scope_manager_agents_update AFTER UPDATE ON manager_agents BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS portfolio_scope_manager_agents_delete AFTER DELETE ON manager_agents BEGIN UPDATE portfolio_revision SET scope_revision=scope_revision+1 WHERE id=1; END;
