const express = require("express");
const db = require("../db");
const { completeDiscordLogin } = require("../auth");

const router = express.Router();

function postLoginRedirect(user) {
  if (user.is_staff) return "/staff";
  const fresh = db.prepare(`SELECT characters_prompted FROM users WHERE id = ?`).get(user.id);
  if (!fresh || !fresh.characters_prompted) {
    db.prepare(`UPDATE users SET characters_prompted = 1 WHERE id = ?`).run(user.id);
    return "/my-characters?welcome=1";
  }
  return "/my-tickets";
}

router.get("/discord/login", (req, res) => {
  req.session.loginFrom = req.query.from === "staff" ? "staff" : "player";
  if (!process.env.DISCORD_CLIENT_ID) {
    const backLink = req.session.loginFrom === "staff" ? "/login" : "/player-login";
    return res.status(500).send(
      "Discord login isn't configured yet -- DISCORD_CLIENT_ID is missing from .env. " +
      (process.env.DEV_LOGIN === "true"
        ? '<a href="/auth/dev-login">Use dev login instead</a>'
        : `<a href="${backLink}">Go back</a>`)
    );
  }
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get("/discord/callback", async (req, res) => {
  const backLink = req.session.loginFrom === "staff" ? "/login" : "/player-login";
  const { code, error } = req.query;
  if (error) return res.redirect(`${backLink}?error=` + encodeURIComponent(error));
  if (!code) return res.redirect(`${backLink}?error=missing_code`);
  try {
    const user = await completeDiscordLogin(code);
    req.session.user = user;
    res.redirect(postLoginRedirect(user));
  } catch (err) {
    console.error("Discord login failed:", err);
    res.redirect(`${backLink}?error=discord_failed`);
  }
});

router.get("/dev-login", (req, res) => {
  if (process.env.DEV_LOGIN !== "true") return res.status(404).send("Not found.");
  res.render("dev-login");
});

router.post("/dev-login", (req, res) => {
  if (process.env.DEV_LOGIN !== "true") return res.status(404).send("Not found.");
  const as = req.body.as === "staff" ? "staff" : "player";
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(as === "staff" ? "dev-staff" : "dev-player");
  const user = row || {
    id: as === "staff" ? "dev-staff" : "dev-player",
    username: as === "staff" ? "Wosy" : "TestPlayer",
    avatar: as === "staff" ? "W" : "T",
    is_staff: as === "staff" ? 1 : 0,
    staff_rank: as === "staff" ? "Senior Gamemaster" : null,
  };
  req.session.user = user;
  res.redirect(postLoginRedirect(user));
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
