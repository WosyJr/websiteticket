const express = require("express");
const db = require("../db");
const { requireLogin, requireStaff } = require("../auth");
const bot = require("../discordBot");

const router = express.Router();

function respond(req, res, payload, redirectTo) {
  const wantsJson = (req.headers.accept || "").includes("application/json");
  if (wantsJson) return res.json(payload);
  res.redirect(redirectTo || req.body.redirect_to || "back");
}

const ACTION_TYPES = ["warn", "timeout", "kick", "ban", "role"];
const ACTION_LABEL = { warn: "Warning", timeout: "Timeout", kick: "Kick", ban: "Ban", role: "Role" };
const STATUS_VALUES = ["available", "busy", "away"];

const insertAction = db.prepare(`
  INSERT INTO moderation_actions
    (target_user_id, type, reason, duration_minutes, role_id, role_label, staff_id, staff_name, notified, ticket_id)
  VALUES (@target_user_id, @type, @reason, @duration_minutes, @role_id, @role_label, @staff_id, @staff_name, @notified, @ticket_id)
`);

router.get("/search", requireStaff, (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  let sql = `
    SELECT DISTINCT u.id, u.username, u.avatar, u.is_staff, u.staff_rank
    FROM users u LEFT JOIN characters c ON c.user_id = u.id
    WHERE (u.username LIKE ? OR u.id = ? OR c.character_name LIKE ? OR c.character_id = ?)`;
  const params = [`%${q}%`, q, `%${q}%`, q];
  if (req.query.staffOnly) sql += ` AND u.is_staff = 1`;
  sql += ` ORDER BY u.username LIMIT 8`;
  res.json(db.prepare(sql).all(...params));
});

router.post("/me/status", requireStaff, (req, res) => {
  const status = STATUS_VALUES.includes(req.body.status) ? req.body.status : "available";
  db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, req.session.user.id);
  res.json({ ok: true, status });
});

router.post("/me/characters", requireLogin, (req, res) => {
  const realm = (req.body.realm || "").trim();
  const name = (req.body.character_name || "").trim();
  if (!db.REALMS.includes(realm)) return res.status(400).json({ error: "Unknown realm." });
  if (!name) return res.status(400).json({ error: "Character name is required." });
  const character = db.addCharacter(req.session.user.id, realm, name, null);
  respond(req, res, { ok: true, character }, "/my-characters");
});

router.post("/me/characters/:charId/remove", requireLogin, (req, res) => {
  const character = db.prepare(`SELECT * FROM characters WHERE id = ?`).get(req.params.charId);
  if (!character || character.user_id !== req.session.user.id) {
    return res.status(404).json({ error: "Character not found." });
  }
  db.removeCharacter(character.id);
  respond(req, res, { ok: true }, "/my-characters");
});

router.post("/:id/characters", requireStaff, (req, res) => {
  const target = db.prepare(`SELECT id FROM users WHERE id = ?`).get(req.params.id);
  if (!target) return res.status(404).json({ error: "Unknown player." });
  const realm = (req.body.realm || "").trim();
  const name = (req.body.character_name || "").trim();
  const characterId = (req.body.character_id || "").trim();
  if (!db.REALMS.includes(realm)) return res.status(400).json({ error: "Unknown realm." });
  if (!name) return res.status(400).json({ error: "Character name is required." });
  const character = db.addCharacter(target.id, realm, name, characterId || null);
  respond(req, res, { ok: true, character }, `/staff/players/${target.id}`);
});

router.post("/characters/:charId", requireStaff, (req, res) => {
  const character = db.prepare(`SELECT * FROM characters WHERE id = ?`).get(req.params.charId);
  if (!character) return res.status(404).json({ error: "Character not found." });
  const fields = {};
  if (req.body.realm !== undefined) {
    if (!db.REALMS.includes(req.body.realm)) return res.status(400).json({ error: "Unknown realm." });
    fields.realm = req.body.realm;
  }
  if (req.body.character_name !== undefined) {
    const name = req.body.character_name.trim();
    if (!name) return res.status(400).json({ error: "Character name is required." });
    fields.character_name = name;
  }
  if (req.body.character_id !== undefined) {
    fields.character_id = req.body.character_id.trim() || null;
  }
  const updated = db.updateCharacter(character.id, fields);
  respond(req, res, { ok: true, character: updated }, `/staff/players/${character.user_id}`);
});

router.post("/characters/:charId/remove", requireStaff, (req, res) => {
  const character = db.prepare(`SELECT * FROM characters WHERE id = ?`).get(req.params.charId);
  if (!character) return res.status(404).json({ error: "Character not found." });
  db.removeCharacter(character.id);
  respond(req, res, { ok: true }, `/staff/players/${character.user_id}`);
});

router.post("/moderation/:actionId/revoke", requireStaff, async (req, res) => {
  const action = db.prepare(`SELECT * FROM moderation_actions WHERE id = ?`).get(req.params.actionId);
  if (!action) return res.status(404).json({ error: "Unknown action." });
  if (action.revoked_at) return res.status(400).json({ error: "Already revoked." });

  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(action.target_user_id);
  const result = await bot.applyModerationRevoke(action);
  if (!result.ok) return res.status(400).json({ error: result.error || "Discord rejected that." });

  db.prepare(
    `UPDATE moderation_actions SET revoked_at = datetime('now'), revoked_by = ?, revoked_by_name = ? WHERE id = ?`
  ).run(req.session.user.id, req.session.user.username, action.id);

  bot
    .notifyModerationRevoked(action, target ? target.username : action.target_user_id, req.session.user.username)
    .catch(() => {});

  const updated = db.prepare(`SELECT * FROM moderation_actions WHERE id = ?`).get(action.id);
  res.json({ ok: true, action: updated });
});

router.post("/:id/moderate", requireStaff, async (req, res) => {
  const type = req.body.type;
  if (!ACTION_TYPES.includes(type)) return res.status(400).json({ error: "Unknown action type." });

  let target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!target && bot.isRealDiscordId(req.params.id)) {
    db.prepare(
      `INSERT INTO users (id, username, avatar, is_staff, staff_rank, is_placeholder) VALUES (?, ?, ?, 0, NULL, 1)`
    ).run(req.params.id, "Unlinked Player", "?");
    target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  }
  if (!target) return res.status(404).json({ error: "Unknown player." });

  const reason = (req.body.reason || "").trim();
  const notify = !!req.body.notify;
  const durationMinutes =
    type === "timeout" ? Math.min(40320, Math.max(1, parseInt(req.body.duration_minutes, 10) || 10)) : null;

  let roleId = null;
  let roleLabel = null;
  if (type === "role") {
    roleId = (req.body.role_id || "").trim();
    if (!roleId) return res.status(400).json({ error: "Pick a role first." });
    const known = db.getModerationRoleOptions().find((r) => r.roleId === roleId);
    roleLabel = known ? known.label : roleId;
  }

  const result = await bot.applyModerationAction({ type, targetId: target.id, reason, durationMinutes, roleId });
  if (!result.ok) {
    return res.status(400).json({ error: result.error || "Discord rejected that action." });
  }

  const info = insertAction.run({
    target_user_id: target.id,
    type,
    reason: reason || null,
    duration_minutes: durationMinutes,
    role_id: roleId,
    role_label: roleLabel,
    staff_id: req.session.user.id,
    staff_name: req.session.user.username,
    notified: notify ? 1 : 0,
    ticket_id: req.body.ticket_id || null,
  });

  bot
    .notifyModeration(
      { type, reason, durationMinutes, roleLabel, staffName: req.session.user.username, targetId: target.id, notify },
      target.username
    )
    .catch(() => {});

  if (req.body.ticket_id) {
    const ticket = db.prepare(`SELECT id FROM tickets WHERE id = ?`).get(req.body.ticket_id);
    if (ticket) {
      const detail =
        type === "timeout" ? ` (${durationMinutes} min)` : type === "role" ? ` (${roleLabel})` : "";
      db.prepare(`INSERT INTO messages (ticket_id, author_id, visible_to_player, body) VALUES (?, ?, 0, ?)`).run(
        ticket.id,
        req.session.user.id,
        `${ACTION_LABEL[type]}${detail} issued to ${target.username} by ${req.session.user.username}.` +
          (reason ? ` Reason: ${reason}` : "")
      );
      db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticket.id);
    }
  }

  const action = db.prepare(`SELECT * FROM moderation_actions WHERE id = ?`).get(info.lastInsertRowid);
  res.json({ ok: true, action });
});

module.exports = router;
