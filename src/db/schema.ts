import type Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  tg_id            INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  tz_offset_min    INTEGER NOT NULL DEFAULT 0,
  nlp_enabled      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id          INTEGER NOT NULL REFERENCES users(tg_id),
  kind                TEXT    NOT NULL CHECK (kind IN ('text', 'voice', 'image', 'document')),
  raw_text            TEXT,
  media_url           TEXT,
  received_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  forwarded_from_chat TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id  INTEGER NOT NULL REFERENCES users(tg_id),
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  user_tg_id        INTEGER NOT NULL REFERENCES users(tg_id),
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  deadline          TEXT,
  priority          TEXT    NOT NULL DEFAULT 'med' CHECK (priority IN ('low', 'med', 'high')),
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  source_message_id INTEGER          REFERENCES messages(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER          REFERENCES projects(id),
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  context    TEXT    NOT NULL DEFAULT '',
  choice     TEXT    NOT NULL DEFAULT '',
  outcome    TEXT,
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  made_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER          REFERENCES projects(id),
  user_tg_id  INTEGER NOT NULL REFERENCES users(tg_id),
  description TEXT    NOT NULL DEFAULT '',
  severity    TEXT    NOT NULL DEFAULT 'med' CHECK (severity IN ('low', 'med', 'high')),
  mitigation  TEXT,
  owner_tg_id INTEGER,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigated'))
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id  INTEGER NOT NULL REFERENCES users(tg_id),
  ref_kind    TEXT    NOT NULL CHECK (ref_kind IN ('task', 'decision', 'risk')),
  ref_id      INTEGER NOT NULL,
  deadline    TEXT    NOT NULL,
  priority    TEXT    NOT NULL DEFAULT 'med' CHECK (priority IN ('low', 'med', 'high')),
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dismissed')),
  notified_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS summaries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  week_start TEXT    NOT NULL,
  body_md    TEXT    NOT NULL DEFAULT '',
  sent_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id  INTEGER NOT NULL REFERENCES users(tg_id),
  phrase      TEXT    NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  window_days INTEGER NOT NULL DEFAULT 7,
  first_seen  TEXT,
  last_seen   TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_user       ON messages (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_messages_received    ON messages (received_at);
CREATE INDEX IF NOT EXISTS idx_projects_user        ON projects (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_projects_status      ON projects (status);
CREATE INDEX IF NOT EXISTS idx_tasks_project        ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user           ON tasks (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline       ON tasks (deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_source_msg     ON tasks (source_message_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project    ON decisions (project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_user       ON decisions (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status     ON decisions (status);
CREATE INDEX IF NOT EXISTS idx_risks_project        ON risks (project_id);
CREATE INDEX IF NOT EXISTS idx_risks_user           ON risks (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_risks_status         ON risks (status);
CREATE INDEX IF NOT EXISTS idx_follow_ups_user      ON follow_ups (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_deadline  ON follow_ups (deadline);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status    ON follow_ups (status);
CREATE INDEX IF NOT EXISTS idx_summaries_user       ON summaries (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_patterns_user        ON patterns (user_tg_id);
CREATE INDEX IF NOT EXISTS idx_patterns_phrase      ON patterns (user_tg_id, phrase);
`;

export function initializeSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

export default initializeSchema;
