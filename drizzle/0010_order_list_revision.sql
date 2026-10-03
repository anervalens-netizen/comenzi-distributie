-- Bounded order-list reads use this monotonic token to reject cursors created
-- before a write. The authoritative order rows remain unchanged.
CREATE TABLE IF NOT EXISTS order_list_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO order_list_revision VALUES(1,1);
CREATE INDEX IF NOT EXISTS idx_orders_created_id ON orders(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_created_id ON orders(user_id,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS order_list_revision_insert;
CREATE TRIGGER order_list_revision_insert AFTER INSERT ON orders BEGIN
  UPDATE order_list_revision SET revision=revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS order_list_revision_update;
CREATE TRIGGER order_list_revision_update AFTER UPDATE ON orders BEGIN
  UPDATE order_list_revision SET revision=revision+1 WHERE id=1;
END;
DROP TRIGGER IF EXISTS order_list_revision_delete;
CREATE TRIGGER order_list_revision_delete AFTER DELETE ON orders BEGIN
  UPDATE order_list_revision SET revision=revision+1 WHERE id=1;
END;
