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

const QUESTIONS_BY_TYPE = {
  player_report: [
    "What server is this report for?",
    "Character Name of Reported Player",
    "Character ID of Reported Player",
    "What rules were broken?",
    "Attach / Link Evidence",
  ],
  item_restoration: [
    "Please confirm the server you are requesting a restoration for.",
    "Link videos or screenshots that prove you had the items requested.",
    "What is your character name?",
    "What is your character ID?",
    "What is the date / time you lost the item? Include time zone.",
    "What do you need restored?",
    "Where was the item removed from?",
    "What is the chest REF ID (if item was taken from a chest) -- if it was taken off your character, put N/A.",
    "How did you lose your item(s)?",
  ],
  general: ["What server is this for?", "How can we help?"],
  staff_report: ["Which staff member is this about?", "What happened?"],
  bug_report: ["What server is this on?", "What happened, and how can we reproduce it?"],
  support_application: [
    "What is your Discord username and character name?",
    "Why do you want to become a Gamemaster?",
    "Do you have any prior staff or moderation experience?",
    "How many hours per week can you commit?",
    "Anything else we should know?",
  ],
  modder_application: [
    "What is your Discord username and character name?",
    "What modding, scripting, or level-design experience do you have?",
    "Link a portfolio, GitHub, or examples of past work.",
    "What would you like to work on for Keizaal Online?",
    "How many hours per week can you commit?",
  ],
  media_application: [
    "What is your Discord username and character name?",
    "Link examples of your clips, screenshots, or edits.",
    "What tools or software do you use?",
    "How often could you create content for us?",
    "Anything else we should know?",
  ],
};

const TYPE_LABEL = {
  player_report: "Player Report",
  item_restoration: "Item Restoration",
  general: "General Support",
  staff_report: "Staff Report",
  bug_report: "Bug Report",
  support_application: "Support Application",
  modder_application: "Modder Application",
  media_application: "Media Application",
};

const APPLICATION_TYPES = ["support_application", "modder_application", "media_application"];

function categoryLabel(type, realm) {
  if (type === "player_report") return `${realm} Player Reports`;
  if (type === "item_restoration") return `${realm} Item Restoration`;
  if (type === "general") return `${realm} General Tickets`;
  return TYPE_LABEL[type] || type;
}

const SUBJECT_ANSWER_INDEX = {
  player_report: 3, // "What rules were broken?"
  item_restoration: 5, // "What do you need restored?"
  general: 1, // "How can we help?"
  staff_report: 1, // "What happened?"
  bug_report: 1, // "What happened, and how can we reproduce it?"
};

function truncate(str, max) {
  const s = (str || "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1).trim() + "..." : s;
}

function buildSubject(type, form, explicitSubject) {
  if (explicitSubject) return explicitSubject;
  const idx = SUBJECT_ANSWER_INDEX[type];
  if (idx != null) {
    const answer = truncate(form[idx] && form[idx].answer, 100);
    if (answer) return answer;
  }
  return TYPE_LABEL[type] || type;
}

const insertTicket = db.prepare(`
  INSERT INTO tickets (type, realm, category_label, subject, reporter_id, form_json)
  VALUES (@type, @realm, @category_label, @subject, @reporter_id, @form_json)
`);
const updateOwnCharacter = db.prepare(
  `UPDATE users SET character_name = ?, character_id = ?, realm = ? WHERE id = ?`
);

function captureOwnCharacter(type, form, realm, reporterId) {
  if (type !== "item_restoration") return;
  const name = (form[2] && form[2].answer || "").trim();
  const id = (form[3] && form[3].answer || "").trim();
  if (!name && !id) return;
  updateOwnCharacter.run(name || null, id || null, realm || null, reporterId);
}

function resolveReportedPlayer(ticket) {
  if (ticket.type !== "player_report") return null;
  const name = (ticket.form[1] && ticket.form[1].answer || "").trim();
  const charId = (ticket.form[2] && ticket.form[2].answer || "").trim();
  let user = null;
  if (charId) user = db.prepare(`SELECT * FROM users WHERE character_id = ? COLLATE NOCASE`).get(charId);
  if (!user && name) user = db.prepare(`SELECT * FROM users WHERE character_name = ? COLLATE NOCASE`).get(name);
  return { typedName: name || null, typedId: charId || null, user: user || null };
}
const insertParticipant = db.prepare(`
  INSERT OR IGNORE INTO ticket_participants (ticket_id, user_id, role) VALUES (?, ?, ?)
`);
const insertMessage = db.prepare(`
  INSERT INTO messages (ticket_id, author_id, visible_to_player, body) VALUES (?, ?, ?, ?)
`);
const touchTicket = db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`);

function isParticipant(ticketId, userId) {
  return !!db
    .prepare(`SELECT 1 FROM ticket_participants WHERE ticket_id = ? AND user_id = ?`)
    .get(ticketId, userId);
}

function getTicketFull(id) {
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id);
  if (!ticket) return null;
  ticket.form = JSON.parse(ticket.form_json);
  ticket.reporter = db.prepare(`SELECT id, username, avatar FROM users WHERE id = ?`).get(ticket.reporter_id);
  ticket.claimer = ticket.claimed_by
    ? db.prepare(`SELECT id, username, avatar FROM users WHERE id = ?`).get(ticket.claimed_by)
    : null;
  ticket.participants = db
    .prepare(
      `SELECT u.id, u.username, u.avatar, p.role FROM ticket_participants p
       JOIN users u ON u.id = p.user_id WHERE p.ticket_id = ?`
    )
    .all(id);
  ticket.messages = db
    .prepare(
      `SELECT m.*, u.username as author_name, u.avatar as author_avatar, u.is_staff as author_is_staff,
              u.staff_rank as author_rank
       FROM messages m JOIN users u ON u.id = m.author_id
       WHERE m.ticket_id = ? ORDER BY m.id ASC`
    )
    .all(id);
  return ticket;
}

router.post("/", requireLogin, (req, res) => {
  const { type, realm, answers, subject: explicitSubject } = req.body;
  if (!QUESTIONS_BY_TYPE[type]) return res.status(400).json({ error: "Unknown ticket type." });
  const questions = QUESTIONS_BY_TYPE[type];
  const form = questions.map((q, i) => ({ question: q, answer: (answers && answers[i]) || "" }));
  const subject = buildSubject(type, form, explicitSubject);

  const info = insertTicket.run({
    type,
    realm: realm || null,
    category_label: categoryLabel(type, realm),
    subject,
    reporter_id: req.session.user.id,
    form_json: JSON.stringify(form),
  });
  insertParticipant.run(info.lastInsertRowid, req.session.user.id, "owner");
  captureOwnCharacter(type, form, realm, req.session.user.id);
  insertMessage.run(
    info.lastInsertRowid,
    req.session.user.id,
    1,
    "Ticket opened | See the submitted form above for details."
  );
  bot
    .notifyTicketOpened(
      { id: info.lastInsertRowid, subject, category_label: categoryLabel(type, realm) },
      req.session.user.username
    )
    .catch(() => {});
  respond(req, res, { id: info.lastInsertRowid }, `/my-tickets/${info.lastInsertRowid}`);
});

router.get("/", requireStaff, (req, res) => {
  const { realm, status, q } = req.query;
  let sql = `
    SELECT t.*, u.username as reporter_name, c.username as claimer_name
    FROM tickets t
    JOIN users u ON u.id = t.reporter_id
    LEFT JOIN users c ON c.id = t.claimed_by
    WHERE 1=1`;
  const params = [];
  if (realm) {
    sql += ` AND t.realm = ?`;
    params.push(realm);
  }
  if (status) {
    sql += ` AND t.status = ?`;
    params.push(status);
  }
  if (q) {
    sql += ` AND (t.subject LIKE ? OR u.username LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY t.updated_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.get("/mine", requireLogin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.* FROM tickets t
       JOIN ticket_participants p ON p.ticket_id = t.id
       WHERE p.user_id = ? ORDER BY t.updated_at DESC`
    )
    .all(req.session.user.id);
  res.json(rows);
});

router.get("/:id", requireLogin, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Not found." });
  const user = req.session.user;
  if (!user.is_staff && !isParticipant(ticket.id, user.id)) {
    return res.status(403).json({ error: "Not your ticket." });
  }
  if (!user.is_staff) ticket.messages = ticket.messages.filter((m) => m.visible_to_player);
  res.json(ticket);
});

router.post("/:id/messages", requireLogin, (req, res) => {
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Not found." });
  const user = req.session.user;
  if (!user.is_staff && !isParticipant(ticket.id, user.id)) {
    return res.status(403).json({ error: "Not your ticket." });
  }
  const body = (req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Message can't be empty." });
  const visible = user.is_staff ? (req.body.visible_to_player ? 1 : 0) : 1;
  insertMessage.run(ticket.id, user.id, visible, body);
  touchTicket.run(ticket.id);
  if (user.is_staff && visible) {
    bot.notifyReply(ticket, user.username, ticket.reporter_id).catch(() => {});
  }
  respond(req, res, { ok: true });
});

router.post("/:id/claim", requireStaff, (req, res) => {
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id);
  db.prepare(`UPDATE tickets SET status = 'claimed', claimed_by = ?, updated_at = datetime('now') WHERE id = ?`).run(
    req.session.user.id,
    req.params.id
  );
  insertParticipant.run(req.params.id, req.session.user.id, "staff");
  if (ticket) bot.notifyClaimed(ticket, req.session.user.username).catch(() => {});
  respond(req, res, { ok: true }, `/staff/tickets/${req.params.id}`);
});

function closeTicket(ticketId, staffUser, reason) {
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(ticketId);
  if (!ticket || ticket.status === "closed") return ticket;
  db.prepare(`UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(ticketId);
  insertMessage.run(
    ticketId,
    staffUser.id,
    1,
    reason ? `Ticket closed by ${staffUser.username}. Reason: ${reason}` : `Ticket closed by ${staffUser.username}.`
  );
  bot.notifyClosed(ticket, staffUser.username, ticket.reporter_id, reason).catch(() => {});
  return ticket;
}

router.post("/:id/close", requireStaff, (req, res) => {
  const reason = (req.body.reason || "").trim();
  closeTicket(req.params.id, req.session.user, reason);
  respond(req, res, { ok: true }, `/staff/tickets/${req.params.id}`);
});

router.post("/:id/decision", requireStaff, (req, res) => {
  const decision = req.body.decision === "approved" ? "approved" : "denied";
  const reason = (req.body.reason || "").trim();
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id);
  db.prepare(
    `UPDATE tickets SET decision = ?, status = 'closed', updated_at = datetime('now') WHERE id = ? AND type = 'item_restoration'`
  ).run(decision, req.params.id);
  if (ticket) {
    insertMessage.run(
      req.params.id,
      req.session.user.id,
      1,
      reason
        ? `Ticket marked ${decision} by ${req.session.user.username}. Reason: ${reason}`
        : `Ticket marked ${decision} by ${req.session.user.username}.`
    );
    bot.notifyDecision(ticket, req.session.user.username, ticket.reporter_id, decision, reason).catch(() => {});
  }
  respond(req, res, { ok: true, decision }, `/staff/tickets/${req.params.id}`);
});

router.post("/:id/participants", requireStaff, (req, res) => {
  const input = (req.body.username || "").trim();
  const user = db
    .prepare(`SELECT * FROM users WHERE id = ? OR username = ? COLLATE NOCASE`)
    .get(input, input);
  if (!user) {
    if ((req.headers.accept || "").includes("application/json")) {
      return res.status(404).json({
        error: "No known user with that exact username or Discord ID yet -- they need to have logged in at least once.",
      });
    }
    return res.redirect(`/staff/tickets/${req.params.id}?error=user_not_found`);
  }
  insertParticipant.run(req.params.id, user.id, "added_player");
  const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(req.params.id);
  if (ticket) bot.notifyParticipantAdded(ticket, req.session.user.username, user.username).catch(() => {});
  respond(
    req,
    res,
    { ok: true, user: { id: user.id, username: user.username, avatar: user.avatar } },
    `/staff/tickets/${req.params.id}`
  );
});

router.post("/bulk-claim", requireStaff, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  for (const id of ids) {
    const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ? AND status != 'closed'`).get(id);
    if (!ticket) continue;
    db.prepare(`UPDATE tickets SET status = 'claimed', claimed_by = ?, updated_at = datetime('now') WHERE id = ?`).run(
      req.session.user.id,
      id
    );
    insertParticipant.run(id, req.session.user.id, "staff");
    bot.notifyClaimed(ticket, req.session.user.username).catch(() => {});
  }
  res.json({ ok: true, count: ids.length });
});

router.post("/bulk-close", requireStaff, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  const reason = (req.body.reason || "").trim();
  for (const id of ids) closeTicket(id, req.session.user, reason);
  res.json({ ok: true, count: ids.length });
});

router.post("/bulk-assign", requireStaff, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids].filter(Boolean);
  const input = (req.body.staff || "").trim();
  const staffUser = db
    .prepare(`SELECT * FROM users WHERE (id = ? OR username = ? COLLATE NOCASE) AND is_staff = 1`)
    .get(input, input);
  if (!staffUser) return res.status(404).json({ error: "No known staff member with that exact username or Discord ID." });
  for (const id of ids) {
    const ticket = db.prepare(`SELECT * FROM tickets WHERE id = ? AND status != 'closed'`).get(id);
    if (!ticket) continue;
    db.prepare(`UPDATE tickets SET status = 'claimed', claimed_by = ?, updated_at = datetime('now') WHERE id = ?`).run(
      staffUser.id,
      id
    );
    insertParticipant.run(id, staffUser.id, "staff");
    bot.notifyClaimed(ticket, `${req.session.user.username} (assigned to ${staffUser.username})`).catch(() => {});
  }
  res.json({ ok: true, count: ids.length, staff: { id: staffUser.id, username: staffUser.username } });
});

module.exports = {
  router,
  QUESTIONS_BY_TYPE,
  TYPE_LABEL,
  APPLICATION_TYPES,
  categoryLabel,
  getTicketFull,
  resolveReportedPlayer,
};
