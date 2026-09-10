require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const db = require("./db");
const authRoutes = require("./routes/auth");
const { router: ticketsApi, APPLICATION_TYPES } = require("./routes/tickets");
const kbApi = require("./routes/kb");
const playersApi = require("./routes/players");
const pages = require("./routes/pages");
const { timeAgo } = require("./lib/relativeTime");
const { isRealDiscordId } = require("./discordBot");
const APPLICATION_PLACEHOLDERS = APPLICATION_TYPES.map(() => "?").join(",");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.locals.timeAgo = timeAgo;
app.locals.isRealDiscordId = isRealDiscordId;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.devLogin = process.env.DEV_LOGIN === "true";
  next();
});

app.use((req, res, next) => {
  if (req.session.user && req.session.user.is_staff) {
    try {
      res.locals.openApplicationsCount = db
        .prepare(
          `SELECT COUNT(*) as c FROM tickets WHERE type IN (${APPLICATION_PLACEHOLDERS}) AND status != 'closed'`
        )
        .get(...APPLICATION_TYPES).c;
    } catch {
      res.locals.openApplicationsCount = 0;
    }
    try {
      res.locals.isManagement = db.isManagement(req.session.user);
    } catch {
      res.locals.isManagement = false;
    }
    try {
      const row = db.prepare(`SELECT status FROM users WHERE id = ?`).get(req.session.user.id);
      res.locals.myStatus = row ? row.status : "available";
      res.locals.myStats = {
        closedCount: db
          .prepare(`SELECT COUNT(*) as c FROM tickets WHERE claimed_by = ? AND status = 'closed'`)
          .get(req.session.user.id).c,
      };
    } catch {
      res.locals.myStatus = "available";
      res.locals.myStats = { closedCount: 0 };
    }
  }
  next();
});

app.use("/auth", authRoutes);
app.use("/api/tickets", ticketsApi);
app.use("/api/kb", kbApi);
app.use("/api/players", playersApi);
app.use("/", pages);

app.use((req, res) => res.status(404).send("Not found."));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Something went wrong: " + err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Keizaal Online website running at http://localhost:${PORT}`);
  if (process.env.DEV_LOGIN === "true") {
    console.log(`Dev login (no Discord needed): http://localhost:${PORT}/auth/dev-login`);
  }
});
