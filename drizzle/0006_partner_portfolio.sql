-- Additive Partner Hub schema. Also loaded idempotently by the Node adapter.
CREATE TABLE IF NOT EXISTS partner_profiles (
  customer_id TEXT PRIMARY KEY NOT NULL REFERENCES customers(id),
  contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  latitude REAL, longitude REAL, position_source TEXT, position_accuracy REAL, position_provider TEXT, position_metadata TEXT,
  address_fingerprint TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL, updated_by TEXT REFERENCES users(id),
  CHECK ((latitude IS NULL AND longitude IS NULL AND position_source IS NULL AND position_accuracy IS NULL)
    OR (latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90
      AND longitude BETWEEN -180 AND 180 AND position_source IS NOT NULL AND position_source IN ('manual','gps','geocoding'))),
  CHECK (position_accuracy IS NULL OR position_accuracy >= 0),
  CHECK (position_source IS NOT 'geocoding' OR (position_provider IS NOT NULL AND position_metadata IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS partner_visits (
  id TEXT PRIMARY KEY NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id),
  agent_id TEXT NOT NULL REFERENCES users(id), agent_name TEXT NOT NULL,
  visited_at TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partner_visits_customer_date ON partner_visits(customer_id,visited_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_partner_visits_agent_date ON partner_visits(agent_id,visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_requests_customer_confirmed ON partner_requests(customer_id,confirmed_at DESC);
-- This protects EVERY customer update path, including imports and A -> B -> A edits.
-- Membership/route/name-only changes intentionally preserve the saved position.
CREATE TRIGGER IF NOT EXISTS partner_profile_address_changed
AFTER UPDATE OF data ON customers
WHEN COALESCE(json_extract(OLD.data,'$.address'),'') IS NOT COALESCE(json_extract(NEW.data,'$.address'),'')
  OR COALESCE(json_extract(OLD.data,'$.city'),'') IS NOT COALESCE(json_extract(NEW.data,'$.city'),'')
  OR COALESCE(json_extract(OLD.data,'$.county'),'') IS NOT COALESCE(json_extract(NEW.data,'$.county'),'')
BEGIN
  UPDATE partner_profiles SET latitude=NULL,longitude=NULL,position_source=NULL,position_accuracy=NULL,
    position_provider=NULL,position_metadata=NULL,address_fingerprint='',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=NULL
  WHERE customer_id=NEW.id;
END;
