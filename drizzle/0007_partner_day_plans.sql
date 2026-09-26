CREATE TABLE IF NOT EXISTS partner_day_plans (
 agent_id TEXT NOT NULL REFERENCES users(id),
 plan_date TEXT NOT NULL CHECK(length(plan_date)=10),
 stops TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(stops) AND json_type(stops)='array'),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(agent_id,plan_date)
);
