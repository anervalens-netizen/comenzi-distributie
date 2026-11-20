CREATE TABLE IF NOT EXISTS manager_ai_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  effort TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manager_ai_conversation_owner ON manager_ai_conversations(owner,updated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS manager_ai_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES manager_ai_conversations(id),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attachments TEXT NOT NULL,
  UNIQUE(conversation_id,ordinal)
);

CREATE TABLE IF NOT EXISTS manager_ai_runs (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES manager_ai_conversations(id),
  account_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  processed_order_key INTEGER,
  terminal_message_id TEXT REFERENCES manager_ai_messages(id),
  control_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS manager_ai_run_active_conversation ON manager_ai_runs(conversation_id) WHERE state='running';
CREATE UNIQUE INDEX IF NOT EXISTS manager_ai_run_active_account ON manager_ai_runs(account_id) WHERE state='running';

CREATE TABLE IF NOT EXISTS manager_ai_submissions (
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES manager_ai_conversations(id),
  run_id TEXT NOT NULL REFERENCES manager_ai_runs(id),
  message_id TEXT NOT NULL REFERENCES manager_ai_messages(id),
  order_key INTEGER NOT NULL,
  mode TEXT NOT NULL,
  digest TEXT NOT NULL,
  context TEXT NOT NULL,
  PRIMARY KEY(conversation_id,id)
);
CREATE INDEX IF NOT EXISTS manager_ai_run_submissions ON manager_ai_submissions(run_id,order_key);
CREATE UNIQUE INDEX IF NOT EXISTS manager_ai_message_submission ON manager_ai_submissions(message_id);

CREATE TABLE IF NOT EXISTS manager_ai_events (
  run_id TEXT NOT NULL REFERENCES manager_ai_runs(id),
  sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(run_id,sequence)
);

CREATE TABLE IF NOT EXISTS manager_ai_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES manager_ai_conversations(id),
  owner TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS manager_ai_artifact_owner ON manager_ai_artifacts(owner);
