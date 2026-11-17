CREATE TABLE IF NOT EXISTS employee_profiles (
 user_id TEXT PRIMARY KEY REFERENCES users(id), legal_name TEXT NOT NULL, employer TEXT NOT NULL DEFAULT '',
 approvers TEXT NOT NULL DEFAULT '[]', email TEXT NOT NULL DEFAULT '', approver_id TEXT REFERENCES users(id), approver_email TEXT NOT NULL DEFAULT '',
 holiday_calendar TEXT NOT NULL DEFAULT 'orthodox' CHECK(holiday_calendar IN ('orthodox','western')),
 extra_holidays TEXT NOT NULL DEFAULT '[]', verified INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO employee_profiles(user_id,legal_name,updated_at) SELECT id,name,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users WHERE role='agent';
CREATE TABLE IF NOT EXISTS leave_requests (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES users(id), approver_id TEXT NOT NULL REFERENCES users(id),
 start_date TEXT NOT NULL, end_date TEXT NOT NULL, days INTEGER NOT NULL CHECK(days>0),
 status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved','rejected','cancelled')),
 snapshot TEXT NOT NULL, signature TEXT, signed_at TEXT, submitted_at TEXT, decision_note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS leave_agent_dates ON leave_requests(agent_id,start_date,end_date,status);
CREATE INDEX IF NOT EXISTS leave_approver_status ON leave_requests(approver_id,status,created_at);
CREATE TABLE IF NOT EXISTS leave_documents (
 request_id TEXT NOT NULL REFERENCES leave_requests(id), version INTEGER NOT NULL, kind TEXT NOT NULL,
 content TEXT NOT NULL, mime TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(request_id,version,kind)
);
CREATE TABLE IF NOT EXISTS leave_events (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES leave_requests(id), actor_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leave_events_request ON leave_events(request_id,created_at);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES users(id), event_key TEXT NOT NULL,
 category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
 created_at TEXT NOT NULL, read_at TEXT, UNIQUE(recipient_id,event_key)
);
CREATE INDEX IF NOT EXISTS notifications_recipient_date ON notifications(recipient_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(recipient_id,read_at);

CREATE TRIGGER IF NOT EXISTS employee_profile_on_user_insert AFTER INSERT ON users WHEN NEW.role='agent'
BEGIN
 INSERT OR IGNORE INTO employee_profiles(user_id,legal_name,updated_at) VALUES(NEW.id,NEW.name,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
