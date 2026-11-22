CREATE TABLE IF NOT EXISTS manager_ai_presentations (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES manager_ai_messages(id) ON DELETE CASCADE,
  body TEXT NOT NULL
);
