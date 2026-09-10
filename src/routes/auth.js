const express = require("express");
const { completeDiscordLogin } = require("../auth");

const router = express.Router();

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
    res.redirect(user.is_staff ? "/staff" : "/my-tickets");
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
  req.session.user =
    as === "staff"
      ? { id: "dev-staff", username: "Wosy", avatar: "W", is_staff: 1, staff_rank: "Gamemaster" }
      : { id: "dev-player", username: "TestPlayer", avatar: "T", is_staff: 0, staff_rank: null };
  res.redirect(as === "staff" ? "/staff" : "/my-tickets");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
