const express = require("express");
const db = require("../db");
const { requireStaff } = require("../auth");

const router = express.Router();
const REALMS = ["general", "sovngarde", "paarthurnax", "moonshadow"];

router.get("/:realm", requireStaff, (req, res) => {
  if (!REALMS.includes(req.params.realm)) return res.status(400).json({ error: "Unknown realm." });
  const rows = db
    .prepare(
      `SELECT a.*, u.username as author_name FROM kb_articles a
       JOIN users u ON u.id = a.author_id
       WHERE a.realm = ? ORDER BY a.pinned DESC, a.created_at DESC`
    )
    .all(req.params.realm);
  res.json(rows);
});

router.post("/:realm", requireStaff, (req, res) => {
  if (!REALMS.includes(req.params.realm)) return res.status(400).json({ error: "Unknown realm." });
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  if (!title || !body) return res.status(400).json({ error: "Title and body are required." });
  const info = db
    .prepare(`INSERT INTO kb_articles (realm, title, body, author_id) VALUES (?, ?, ?, ?)`)
    .run(req.params.realm, title, body, req.session.user.id);
  const wantsJson = (req.headers.accept || "").includes("application/json");
  if (wantsJson) return res.json({ id: info.lastInsertRowid });
  res.redirect(`/staff/kb?realm=${req.params.realm}`);
});

router.post("/articles/:id/pin", requireStaff, (req, res) => {
  const article = db.prepare(`SELECT * FROM kb_articles WHERE id = ?`).get(req.params.id);
  if (!article) return res.status(404).json({ error: "Article not found." });
  db.prepare(`UPDATE kb_articles SET pinned = ? WHERE id = ?`).run(article.pinned ? 0 : 1, req.params.id);
  const wantsJson = (req.headers.accept || "").includes("application/json");
  if (wantsJson) return res.json({ ok: true, pinned: !article.pinned });
  res.redirect(`/staff/kb/article/${req.params.id}`);
});

router.post("/articles/:id/comments", requireStaff, (req, res) => {
  const article = db.prepare(`SELECT * FROM kb_articles WHERE id = ?`).get(req.params.id);
  if (!article) return res.status(404).json({ error: "Article not found." });
  const body = (req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Comment can't be empty." });
  db.prepare(`INSERT INTO kb_comments (article_id, author_id, body) VALUES (?, ?, ?)`).run(
    req.params.id,
    req.session.user.id,
    body
  );
  const wantsJson = (req.headers.accept || "").includes("application/json");
  if (wantsJson) return res.json({ ok: true });
  res.redirect(`/staff/kb/article/${req.params.id}`);
});

module.exports = router;
