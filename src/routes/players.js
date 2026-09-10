const express = require("express");
const db = require("../db");
const { requireStaff } = require("../auth");
const bot = require("../discordBot");

const router = express.Router();
const ACTION_TYPES = ["warn", "timeout", "kick", "ban", "role"];
const ACTION_LABEL = { warn: "Warning", timeout: "Timeout", kick: "Kick", ban: "Ban", role: "Role" };

const insertAction = db.prepare(`
  INSERT INTO moderation_actions
    (target_user_id, type, reason, duration_minutes, role_id, role_label, staff_id, staff_name, notified, ticket_id)
  VALUES (@target_user_id, @type, @reason, @duration_minutes, @role_id, @role_label, @staff_id, @staff_name, @notified, @ticket_id)
`);

router.post("/:id/moderate", requireStaff, async (req, res) => {
  const type = req.body.type;
  if (!ACTION_TYPES.includes(type)) return res.status(400).json({ error: "Unknown action type." });

  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
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
