/**
 * TermHand SQLite 数据层
 * 数据库位置：~/.openclaw/termhand/termhand.db
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(process.env.HOME || '/root', '.openclaw/termhand');
fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'termhand.db');

const db = new Database(DB_PATH);

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    shell TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    last_active INTEGER DEFAULT (strftime('%s','now')),
    auto_restore INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS session_logs (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    ts INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_logs_session ON session_logs(session_id, ts);
`);

// ── Sessions ──────────────────────────────────────────────────

const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, cwd, shell, last_active, auto_restore)
    VALUES (@id, @cwd, @shell, strftime('%s','now'), 1)
    ON CONFLICT(id) DO UPDATE SET
      cwd = excluded.cwd,
      shell = excluded.shell,
      last_active = strftime('%s','now'),
      auto_restore = 1
  `),

  getAutoRestoreSessions: db.prepare(`
    SELECT id, cwd, shell FROM sessions
    WHERE auto_restore = 1
    ORDER BY last_active DESC
  `),

  setAutoRestore: db.prepare(`
    UPDATE sessions SET auto_restore = @flag WHERE id = @id
  `),

  touchSession: db.prepare(`
    UPDATE sessions SET last_active = strftime('%s','now') WHERE id = @id
  `),

  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = @id`),

  // ── Logs ──────────────────────────────────────────────────
  insertLog: db.prepare(`
    INSERT INTO session_logs (session_id, type, content, ts)
    VALUES (@sessionId, @type, @content, strftime('%s','now'))
  `),

  getRecentLogs: db.prepare(`
    SELECT type, content, ts FROM session_logs
    WHERE session_id = @sessionId
    ORDER BY ts DESC, rowid DESC
    LIMIT @limit
  `),

  purgeLogs: db.prepare(`
    DELETE FROM session_logs
    WHERE session_id = @sessionId
    AND rowid NOT IN (
      SELECT rowid FROM session_logs
      WHERE session_id = @sessionId
      ORDER BY rowid DESC LIMIT 2000
    )
  `),
};

module.exports = {
  // session 创建/更新（upsert）
  upsertSession(id, cwd, shell) {
    stmts.upsertSession.run({ id, cwd: cwd || null, shell: shell || null });
  },

  // 获取所有需要自动重建的 session
  getAutoRestoreSessions() {
    return stmts.getAutoRestoreSessions.all();
  },

  // 禁用自动重建（kill 时调用）
  disableAutoRestore(id) {
    stmts.setAutoRestore.run({ id, flag: 0 });
  },

  // 更新最后活跃时间
  touchSession(id) {
    stmts.touchSession.run({ id });
  },

  // 写日志（异步 setImmediate，不阻塞主线程）
  appendLog(sessionId, type, content) {
    setImmediate(() => {
      try {
        stmts.insertLog.run({ sessionId, type, content });
        // 每 100 次写入时清理旧日志，保留最新 2000 条
        if (Math.random() < 0.01) {
          stmts.purgeLogs.run({ sessionId });
        }
      } catch (e) {}
    });
  },

  // 读最近日志
  getRecentLogs(sessionId, limit = 200) {
    return stmts.getRecentLogs.all({ sessionId, limit }).reverse();
  },

  db, // 暴露原始 db 供高级查询
};
