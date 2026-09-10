const express = require("express");
const db = require("../db");
const { requireLogin, requireStaff } = require("../auth");
const { QUESTIONS_BY_TYPE, TYPE_LABEL, APPLICATION_TYPES, getTicketFull, resolveReportedPlayer } = require("./tickets");
const richtext = require("../lib/richtext");

const router = express.Router();
const REALMS = ["Sovngarde", "Paarthurnax", "Moonshadow"];
const KB_REALMS = ["general", "sovngarde", "paarthurnax", "moonshadow"];

function ticketListQuery({ baseWhere = "1=1", baseParams = [], realm, view, q, currentUserId }) {
  let sql = `
    SELECT t.*, u.username as reporter_name, c.username as claimer_name
    FROM tickets t
    JOIN users u ON u.id = t.reporter_id
    LEFT JOIN users c ON c.id = t.claimed_by
    WHERE ${baseWhere}`;
  const params = [...baseParams];
  if (realm) {
    sql += ` AND t.realm = ?`;
    params.push(realm);
  }
  if (view === "unclaimed") {
    sql += ` AND t.status = 'open'`;
  } else if (view === "mine") {
    sql += ` AND t.claimed_by = ? AND t.status != 'closed'`;
    params.push(currentUserId);
  } else if (view === "closed") {
    sql += ` AND t.status = 'closed'`;
  } else if (view === "open") {
    sql += ` AND t.status != 'closed'`;
  }
  if (q) {
    sql += ` AND (t.subject LIKE ? OR u.username LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY t.updated_at DESC`;
  return db.prepare(sql).all(...params);
}

function ticketCounts(baseWhere = "1=1", baseParams = []) {
  return db
    .prepare(
      `SELECT
         SUM(CASE WHEN status != 'closed' THEN 1 ELSE 0 END) as open_count,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as unclaimed_count,
         SUM(CASE WHEN status = 'closed' AND date(updated_at) = date('now') THEN 1 ELSE 0 END) as closed_today
       FROM tickets WHERE ${baseWhere}`
    )
    .get(...baseParams);
}

const APPLICATION_PLACEHOLDERS = APPLICATION_TYPES.map(() => "?").join(",");

function playerSummary(userRow) {
  if (!userRow) return null;
  const modActions = db
    .prepare(
      `SELECT * FROM moderation_actions WHERE target_user_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(userRow.id);
  const ticketCount = db.prepare(`SELECT COUNT(*) as c FROM tickets WHERE reporter_id = ?`).get(userRow.id).c;
  let priorActionsLabel = "None";
  if (modActions.length === 1) priorActionsLabel = `1 ${modActions[0].type}`;
  else if (modActions.length > 1) priorActionsLabel = `${modActions.length} actions`;
  return { user: userRow, modActions, ticketCount, priorActionsLabel };
}

router.get("/", (req, res) => {
  res.render("hub", { user: req.session.user || null });
});

router.get("/login", (req, res) => {
  res.render("login", { error: req.query.error || null, devLogin: process.env.DEV_LOGIN === "true" });
});

router.get("/player-login", (req, res) => {
  res.render("login-player", {
    user: req.session.user || null,
    error: req.query.error || null,
    devLogin: process.env.DEV_LOGIN === "true",
  });
});

router.get("/support/new", (req, res) => {
  const type = QUESTIONS_BY_TYPE[req.query.type] ? req.query.type : "player_report";
  const realm = REALMS.includes(req.query.realm) ? req.query.realm : REALMS[0];
  res.render("new-ticket", {
    user: req.session.user || null,
    type,
    realm,
    realms: REALMS,
    questions: QUESTIONS_BY_TYPE[type],
  });
});

router.get("/my-tickets", requireLogin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.* FROM tickets t
       JOIN ticket_participants p ON p.ticket_id = t.id
       WHERE p.user_id = ? ORDER BY t.updated_at DESC`
    )
    .all(req.session.user.id);
  res.render("my-tickets", { user: req.session.user, tickets: rows });
});

router.get("/my-tickets/:id", requireLogin, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).send("Ticket not found.");
  const isParticipant = ticket.participants.some((p) => p.id === req.session.user.id);
  if (!isParticipant) return res.status(403).send("That's not your ticket.");
  ticket.messages = ticket.messages.filter((m) => m.visible_to_player);
  res.render("ticket-player", { user: req.session.user, ticket });
});

router.get("/staff", requireStaff, (req, res) => {
  const counts = ticketCounts();
  const recentTickets = ticketListQuery({ view: "all" }).slice(0, 8);
  const unclaimedTickets = ticketListQuery({ view: "unclaimed" }).slice(0, 5);
  const myTickets = ticketListQuery({ view: "mine", currentUserId: req.session.user.id }).slice(0, 5);
  const appCounts = ticketCounts(`type IN (${APPLICATION_PLACEHOLDERS})`, APPLICATION_TYPES);
  res.render("staff-overview", {
    user: req.session.user,
    counts,
    appCounts,
    recentTickets,
    unclaimedTickets,
    myTickets,
  });
});

router.get("/staff/tickets", requireStaff, (req, res) => {
  const { realm, view, q } = req.query;
  const tickets = ticketListQuery({ realm, view, q, currentUserId: req.session.user.id });
  const counts = ticketCounts();
  res.render("staff-main", { user: req.session.user, tickets, counts, filters: { realm, view, q } });
});

router.get("/staff/applications", requireStaff, (req, res) => {
  const { view, q } = req.query;
  const tickets = ticketListQuery({
    baseWhere: `t.type IN (${APPLICATION_PLACEHOLDERS})`,
    baseParams: APPLICATION_TYPES,
    view,
    q,
    currentUserId: req.session.user.id,
  });
  const counts = ticketCounts(`type IN (${APPLICATION_PLACEHOLDERS})`, APPLICATION_TYPES);
  res.render("staff-applications", { user: req.session.user, tickets, counts, filters: { view, q }, TYPE_LABEL });
});

router.get("/staff/tickets/:id", requireStaff, (req, res) => {
  const ticket = getTicketFull(req.params.id);
  if (!ticket) return res.status(404).send("Ticket not found.");

  const reportedPlayer = resolveReportedPlayer(ticket);
  const target = reportedPlayer && reportedPlayer.user ? reportedPlayer.user : ticket.reporter;
  const targetSummary = playerSummary(target);
  const roleOptions = db.getModerationRoleOptions();

  res.render("staff-ticket", {
    user: req.session.user,
    ticket,
    error: req.query.error || null,
    reportedPlayer,
    target,
    targetSummary,
    roleOptions,
  });
});

router.get("/staff/players", requireStaff, (req, res) => {
  const q = (req.query.q || "").trim();
  let sql = `
    SELECT u.*,
      (SELECT COUNT(*) FROM tickets t WHERE t.reporter_id = u.id) as ticket_count,
      (SELECT COUNT(*) FROM moderation_actions m WHERE m.target_user_id = u.id) as action_count
    FROM users u WHERE 1=1`;
  const params = [];
  if (q) {
    sql += ` AND (u.username LIKE ? OR u.id = ? OR u.character_name LIKE ? OR u.character_id = ?)`;
    params.push(`%${q}%`, q, `%${q}%`, q);
  }
  sql += ` ORDER BY u.created_at DESC`;
  const players = db.prepare(sql).all(...params);
  res.render("staff-players", { user: req.session.user, players, q });
});

router.get("/staff/players/:id", requireStaff, (req, res) => {
  const player = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!player) return res.status(404).send("Player not found.");
  const summary = playerSummary(player);
  const tickets = db
    .prepare(`SELECT * FROM tickets WHERE reporter_id = ? ORDER BY updated_at DESC`)
    .all(player.id);
  const roleOptions = db.getModerationRoleOptions();
  res.render("staff-player", { user: req.session.user, player, summary, tickets, roleOptions });
});

const KB_SORTS = {
  pinned: "a.pinned DESC, a.created_at DESC",
  newest: "a.created_at DESC",
  oldest: "a.created_at ASC",
  comments: "comment_count DESC, a.created_at DESC",
};

router.get("/staff/kb", requireStaff, (req, res) => {
  const realm = KB_REALMS.includes(req.query.realm) ? req.query.realm : "sovngarde";
  const sort = KB_SORTS[req.query.sort] ? req.query.sort : "pinned";
  const articles = db
    .prepare(
      `SELECT a.*, u.username as author_name,
         (SELECT COUNT(*) FROM kb_comments c WHERE c.article_id = a.id) as comment_count,
         (SELECT COUNT(*) FROM kb_comments c WHERE c.article_id = a.id AND c.created_at >= datetime('now','-1 day')) as new_count
       FROM kb_articles a
       JOIN users u ON u.id = a.author_id
       WHERE a.realm = ?
       ORDER BY ${KB_SORTS[sort]}`
    )
    .all(realm);
  articles.forEach((a) => {
    a.previewHtml = richtext.truncateRich(a.body, 120);
  });
  res.render("staff-kb", { user: req.session.user, realm, articles, sort });
});

router.get("/staff/kb/article/:id", requireStaff, (req, res) => {
  const article = db
    .prepare(
      `SELECT a.*, u.username as author_name, u.avatar as author_avatar
       FROM kb_articles a JOIN users u ON u.id = a.author_id WHERE a.id = ?`
    )
    .get(req.params.id);
  if (!article) return res.status(404).send("Article not found.");
  article.bodyHtml = richtext.renderRichText(article.body);
  const comments = db
    .prepare(
      `SELECT c.*, u.username as author_name, u.avatar as author_avatar, u.is_staff as author_is_staff,
              u.staff_rank as author_rank
       FROM kb_comments c JOIN users u ON u.id = c.author_id
       WHERE c.article_id = ? ORDER BY c.id ASC`
    )
    .all(req.params.id);
  comments.forEach((c) => {
    c.bodyHtml = richtext.renderRichText(c.body);
  });
  res.render("staff-kb-article", { user: req.session.user, article, comments });
});

router.get("/staff/settings", requireStaff, (req, res) => {
  res.render("staff-settings", {
    user: req.session.user,
    settings: db.getAllSettings(),
    saved: req.query.saved === "1",
  });
});

router.post("/staff/settings", requireStaff, (req, res) => {
  db.setSetting("dm_on_reply", req.body.dm_on_reply ? "1" : "0");
  db.setSetting("dm_on_close", req.body.dm_on_close ? "1" : "0");
  db.setSetting("log_enabled", req.body.log_enabled ? "1" : "0");
  db.setSetting("log_channel_id", (req.body.log_channel_id || "").trim());
  db.setSetting("moderation_role_map", (req.body.moderation_role_map || "").trim());
  res.redirect("/staff/settings?saved=1");
});

module.exports = router;
