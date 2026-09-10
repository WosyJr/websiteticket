const db = require("./db");

const upsertUser = db.prepare(`
  INSERT INTO users (id, username, avatar, is_staff, staff_rank, joined_at, is_placeholder)
  VALUES (@id, @username, @avatar, @is_staff, @staff_rank, @joined_at, 0)
  ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar,
    is_staff=excluded.is_staff, staff_rank=excluded.staff_rank,
    joined_at=COALESCE(excluded.joined_at, users.joined_at),
    is_placeholder=0
`);

function roleMap() {
  try {
    return JSON.parse(process.env.STAFF_ROLE_MAP || "{}");
  } catch {
    return {};
  }
}

async function lookupStaffRank(discordUserId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!botToken || !guildId) return { isStaff: false, rank: null, joinedAt: null };

  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) return { isStaff: false, rank: null, joinedAt: null };
  const member = await res.json();
  const map = roleMap();
  const memberRoles = new Set(member.roles || []);
  const joinedAt = member.joined_at || null;
  for (const [roleId, rank] of Object.entries(map)) {
    if (memberRoles.has(roleId)) return { isStaff: true, rank, joinedAt };
  }
  return { isStaff: false, rank: null, joinedAt };
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
  });
  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);
  return res.json();
}

async function completeDiscordLogin(code) {
  const token = await exchangeCodeForToken(code);
  const discordUser = await fetchDiscordUser(token.access_token);
  const { isStaff, rank, joinedAt } = await lookupStaffRank(discordUser.id);

  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=64`
    : null;

  const record = {
    id: discordUser.id,
    username: discordUser.username,
    avatar: avatarUrl || (discordUser.username || "?")[0].toUpperCase(),
    is_staff: isStaff ? 1 : 0,
    staff_rank: rank,
    joined_at: joinedAt,
  };
  upsertUser.run(record);
  return record;
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/player-login");
  next();
}

function requireStaff(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.is_staff) return res.status(403).send("Staff access only.");
  next();
}

function requireManagement(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.is_staff) return res.status(403).send("Staff access only.");
  if (!db.isManagement(req.session.user)) return res.status(403).send("Management access only.");
  next();
}

module.exports = { completeDiscordLogin, requireLogin, requireStaff, requireManagement, upsertUser };
