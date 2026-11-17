CREATE TABLE IF NOT EXISTS order_limit_approvals (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 order_revision INTEGER NOT NULL,
 agent_id TEXT NOT NULL REFERENCES users(id),
 agent_revision INTEGER NOT NULL,
 warehouse_id TEXT NOT NULL,
 manager_ids TEXT NOT NULL,
 input_key TEXT NOT NULL,
 sales_version TEXT NOT NULL,
 mapping_version TEXT NOT NULL,
 policy_version TEXT NOT NULL,
 catalog_version TEXT NOT NULL,
 violations TEXT NOT NULL,
 status TEXT NOT NULL CONSTRAINT order_limit_approvals_status_check CHECK(status IN ('pending','approved','rejected','consumed')),
 reason TEXT NOT NULL DEFAULT '',
 comment TEXT NOT NULL DEFAULT '',
 decided_by TEXT REFERENCES users(id),
 decided_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS order_limit_approvals_order_input ON order_limit_approvals(order_id,order_revision,input_key);
CREATE INDEX IF NOT EXISTS order_limit_approvals_scope ON order_limit_approvals(agent_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS order_limit_approvals_date ON order_limit_approvals(created_at DESC,id DESC);
