import Database from 'better-sqlite3';

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    NOT NULL DEFAULT '',
      kind        TEXT    NOT NULL CHECK (kind IN ('custom', 'installed')),
      transport   TEXT    NOT NULL CHECK (transport IN ('stdio', 'http', 'ws')),
      config      TEXT    NOT NULL,
      tags        TEXT    NOT NULL DEFAULT '[]',
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  TEXT    NOT NULL DEFAULT 'system',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_plugins_name ON plugins(name);
    CREATE INDEX IF NOT EXISTS idx_plugins_tags ON plugins(tags);

    CREATE TABLE IF NOT EXISTS secrets (
      name       TEXT PRIMARY KEY,
      encrypted  TEXT NOT NULL,
      iv         TEXT NOT NULL,
      tag        TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wardens (
      id            TEXT    PRIMARY KEY,
      name          TEXT    NOT NULL UNIQUE,
      label         TEXT    NOT NULL UNIQUE,
      warden_prompt TEXT    NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wardens_label ON wardens(label);

    CREATE TABLE IF NOT EXISTS policies (
      id          TEXT    PRIMARY KEY,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL,
      priority    TEXT    NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
      created_by  TEXT    NOT NULL DEFAULT 'founder',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS policy_updates (
      id          TEXT    PRIMARY KEY,
      policy_id   TEXT    NOT NULL REFERENCES policies(id),
      body        TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_policy_updates_policy ON policy_updates(policy_id);

    CREATE TABLE IF NOT EXISTS event_listeners (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL UNIQUE,
      source      TEXT    NOT NULL,
      config      TEXT    NOT NULL,
      handler     TEXT    NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  TEXT    NOT NULL DEFAULT 'system',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_journal (
      id          TEXT    PRIMARY KEY,
      listener    TEXT    NOT NULL,
      prompt      TEXT    NOT NULL,
      targets     TEXT    NOT NULL DEFAULT '[]',
      delivered   TEXT    NOT NULL DEFAULT '[]',
      failed      TEXT    NOT NULL DEFAULT '[]',
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'delivered', 'dead')),
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_event_journal_status ON event_journal(status);

    CREATE TABLE IF NOT EXISTS telemetry (
      key        TEXT PRIMARY KEY,
      value      REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      content           TEXT NOT NULL,
      source            TEXT NOT NULL,
      tags              TEXT NOT NULL DEFAULT '[]',
      embedding         TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_validated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge(tags);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);

    CREATE TABLE IF NOT EXISTS audit_log (
      id            TEXT PRIMARY KEY,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      agent_type    TEXT,
      ticket_key    TEXT,
      tool_name     TEXT NOT NULL,
      input_hash    TEXT NOT NULL,
      result_status TEXT NOT NULL CHECK (result_status IN ('ok', 'error', 'blocked')),
      duration_ms   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON audit_log(tool_name);
    CREATE INDEX IF NOT EXISTS idx_audit_log_ticket ON audit_log(ticket_key);
  `);

  // FTS5 virtual table — separate exec because CREATE VIRTUAL TABLE
  // doesn't support IF NOT EXISTS in all SQLite builds, so we catch the error.
  try {
    db.exec(`CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, content, tags, content=knowledge, content_rowid=rowid)`);
  } catch {
    // Already exists.
  }

  // Triggers to keep the FTS index in sync with the knowledge table.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);

  return db;
}
