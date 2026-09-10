const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "keizaal.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  avatar TEXT,
  is_staff INTEGER NOT NULL DEFAULT 0,
  staff_rank TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  realm TEXT,
  category_label TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reporter_id TEXT NOT NULL REFERENCES users(id),
  claimed_by TEXT REFERENCES users(id),
  form_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_participants (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'player',
  PRIMARY KEY (ticket_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  visible_to_player INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  realm TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  reason TEXT,
  duration_minutes INTEGER,
  role_id TEXT,
  role_label TEXT,
  staff_id TEXT NOT NULL REFERENCES users(id),
  staff_name TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  ticket_id INTEGER REFERENCES tickets(id),
  revoked_at TEXT,
  revoked_by TEXT,
  revoked_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function addColumnIfMissing(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}
addColumnIfMissing("users", "character_name TEXT");
addColumnIfMissing("users", "character_id TEXT");
addColumnIfMissing("users", "realm TEXT");
addColumnIfMissing("users", "joined_at TEXT");
addColumnIfMissing("users", "is_placeholder INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "status TEXT NOT NULL DEFAULT 'available'");
addColumnIfMissing("moderation_actions", "revoked_at TEXT");
addColumnIfMissing("moderation_actions", "revoked_by TEXT");
addColumnIfMissing("moderation_actions", "revoked_by_name TEXT");

const SETTING_DEFAULTS = {
  dm_on_reply: "1",
  dm_on_close: "1",
  log_enabled: "1",
  log_channel_id: "1547369380600352858",
  moderation_role_map: "",
};
const seedSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(SETTING_DEFAULTS)) seedSetting.run(key, value);

const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : SETTING_DEFAULTS[key];
}
function getAllSettings() {
  const out = {};
  for (const key of Object.keys(SETTING_DEFAULTS)) out[key] = getSetting(key);
  return out;
}
function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

function getModerationRoleOptions() {
  const raw = getSetting("moderation_role_map") || "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(":");
      const label = idx === -1 ? line : line.slice(0, idx).trim();
      const roleId = idx === -1 ? line : line.slice(idx + 1).trim();
      return { label: label || roleId, roleId };
    })
    .filter((r) => r.roleId);
}

const MANAGEMENT_RANKS = ["Senior Gamemaster"];
function isManagement(user) {
  return !!user && !!user.is_staff && MANAGEMENT_RANKS.includes(user.staff_rank);
}

const seedUser = db.prepare(`
  INSERT INTO users (id, username, avatar, is_staff, staff_rank)
  VALUES (@id, @username, @avatar, @is_staff, @staff_rank)
  ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar,
    is_staff=excluded.is_staff, staff_rank=excluded.staff_rank
`);
seedUser.run({ id: "dev-staff", username: "Wosy", avatar: "W", is_staff: 1, staff_rank: "Senior Gamemaster" });
seedUser.run({ id: "dev-player", username: "TestPlayer", avatar: "T", is_staff: 0, staff_rank: null });

db.getSetting = getSetting;
db.getAllSettings = getAllSettings;
db.setSetting = setSetting;
db.getModerationRoleOptions = getModerationRoleOptions;
db.isManagement = isManagement;
db.MANAGEMENT_RANKS = MANAGEMENT_RANKS;

module.exports = db;
