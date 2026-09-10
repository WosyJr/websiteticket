
const db = require("./db");

const API = "https://discord.com/api/v10";
let warnedNoToken = false;

async function discordRequest(path, options = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    if (!warnedNoToken) {
      console.warn("[discordBot] DISCORD_BOT_TOKEN not set -- skipping Discord DMs/logging.");
      warnedNoToken = true;
    }
    return { ok: false, status: 0, error: "Discord bot isn't configured yet." };
  }
  try {
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = body;
      try {
        const parsed = JSON.parse(body);
        message = parsed.message || body;
      } catch {
        /* not JSON, use raw body */
      }
      console.warn(`[discordBot] ${options.method || "GET"} ${path} -> ${res.status} ${body}`);
      return { ok: false, status: res.status, error: message || `Discord returned ${res.status}` };
    }
    if (res.status === 204) return { ok: true, status: 204, data: null };
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (err) {
    console.warn(`[discordBot] request to ${path} failed:`, err.message);
    return { ok: false, status: 0, error: err.message };
  }
}


function isRealDiscordId(id) {
  return typeof id === "string" && /^\d{15,25}$/.test(id);
}

async function sendPayload(channelId, payload) {
  return discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function dmUser(userId, payload) {
  if (!isRealDiscordId(userId)) return { ok: false, error: "Not a real Discord account." };
  const channel = await discordRequest("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!channel.ok || !channel.data || !channel.data.id) return channel;
  return sendPayload(channel.data.id, payload);
}

async function logToChannel(payload) {
  if (db.getSetting("log_enabled") !== "1") return;
  const channelId = (db.getSetting("log_channel_id") || "").trim();
  if (!channelId) return;
  await sendPayload(channelId, payload);
}

function ticketUrl(id) {
  const base = (process.env.BASE_URL || "").replace(/\/$/, "");
  return `${base}/staff/tickets/${id}`;
}

function playerUrl(id) {
  const base = (process.env.BASE_URL || "").replace(/\/$/, "");
  return `${base}/staff/players/${id}`;
}


const COLOR = {
  opened: 0xc9822e,
  reply: 0x5865f2,
  claimed: 0xd8b06a,
  closed: 0xda373c,
  approved: 0x3ba55d,
  denied: 0xda373c,
  participant: 0x8a93a8,
  warn: 0xe8a33d,
  timeout: 0xd8b06a,
  kick: 0xda373c,
  ban: 0x8b1e1e,
  role: 0x5865f2,
};
const FOOTER = { text: "Keizaal Online" };


function field(name, value, inline = true) {
  return value ? { name, value: String(value), inline } : null;
}

function embed({ color, title, description, fields, thumbnail }) {
  const e = {
    title,
    description,
    color,
    fields: (fields || []).filter(Boolean),
    footer: FOOTER,
    timestamp: new Date().toISOString(),
  };
  if (thumbnail) e.thumbnail = { url: thumbnail };
  return { embeds: [e] };
}

function ticketFields(ticket) {
  return [field("Category", ticket.category_label), field("Ticket", `[#${ticket.id}](${ticketUrl(ticket.id)})`)];
}



async function notifyTicketOpened(ticket, reporterName) {
  await logToChannel(
    embed({
      color: COLOR.opened,
      title: "New Ticket",
      description: `**${ticket.subject}**`,
      fields: [field("Opened by", reporterName), ...ticketFields(ticket)],
    })
  );
}

async function notifyReply(ticket, staffName, reporterId) {
  if (db.getSetting("dm_on_reply") !== "1") return;
  await dmUser(
    reporterId,
    embed({
      color: COLOR.reply,
      title: "New reply on your ticket",
      description: `**${staffName}** replied to **${ticket.subject}**\n\n[View and reply](${ticketUrl(ticket.id)})`,
      fields: [field("Ticket", `#${ticket.id}`)],
    })
  );
}

async function notifyClaimed(ticket, staffName) {
  await logToChannel(
    embed({
      color: COLOR.claimed,
      title: "Ticket Claimed",
      description: `**${ticket.subject}**`,
      fields: [field("Claimed by", staffName), ...ticketFields(ticket)],
    })
  );
}

async function notifyClosed(ticket, staffName, reporterId, reason) {
  if (db.getSetting("dm_on_close") === "1") {
    await dmUser(
      reporterId,
      embed({
        color: COLOR.closed,
        title: "Your ticket was closed",
        description: `**${ticket.subject}**\n\n[View ticket](${ticketUrl(ticket.id)})`,
        fields: [field("Closed by", staffName), field("Reason", reason, false)],
      })
    );
  }
  await logToChannel(
    embed({
      color: COLOR.closed,
      title: "Ticket Closed",
      description: `**${ticket.subject}**`,
      fields: [field("Closed by", staffName), field("Reason", reason, false), ...ticketFields(ticket)],
    })
  );
}

async function notifyDecision(ticket, staffName, reporterId, decision, reason) {
  const isApproved = decision === "approved";
  if (db.getSetting("dm_on_close") === "1") {
    await dmUser(
      reporterId,
      embed({
        color: isApproved ? COLOR.approved : COLOR.denied,
        title: isApproved ? "Your ticket was approved" : "Your ticket was denied",
        description: `**${ticket.subject}**\n\n[View ticket](${ticketUrl(ticket.id)})`,
        fields: [field("Decided by", staffName), field("Reason", reason, false)],
      })
    );
  }
  await logToChannel(
    embed({
      color: isApproved ? COLOR.approved : COLOR.denied,
      title: `Ticket ${isApproved ? "Approved" : "Denied"}`,
      description: `**${ticket.subject}**`,
      fields: [field("Decided by", staffName), field("Reason", reason, false), ...ticketFields(ticket)],
    })
  );
}

async function notifyParticipantAdded(ticket, staffName, addedName) {
  await logToChannel(
    embed({
      color: COLOR.participant,
      title: "Player Added to Ticket",
      description: `**${ticket.subject}**`,
      fields: [field("Added by", staffName), field("Player", addedName), ...ticketFields(ticket)],
    })
  );
}


const ACTION_LABEL = { warn: "Warning", timeout: "Timeout", kick: "Kick", ban: "Ban", role: "Role" };
const ACTION_VERB = { warn: "warned", timeout: "timed out", kick: "kicked", ban: "banned", role: "given a role" };

function guildId() {
  return process.env.DISCORD_GUILD_ID;
}

async function applyModerationAction(action) {
  const { type, targetId, reason, durationMinutes, roleId } = action;
  const guild = guildId();
  if (type === "warn") return { ok: true };
  if (!isRealDiscordId(targetId)) {
    return { ok: false, error: "This player doesn't have a real linked Discord account (dev/test user)." };
  }
  if (!guild) return { ok: false, error: "DISCORD_GUILD_ID isn't set -- add it to .env first." };

  const headers = reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason).slice(0, 500) } : {};

  if (type === "timeout") {
    const until = new Date(Date.now() + Math.max(1, durationMinutes || 10) * 60000).toISOString();
    const result = await discordRequest(`/guilds/${guild}/members/${targetId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ communication_disabled_until: until }),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (type === "kick") {
    const result = await discordRequest(`/guilds/${guild}/members/${targetId}`, { method: "DELETE", headers });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (type === "ban") {
    const result = await discordRequest(`/guilds/${guild}/bans/${targetId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({}),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (type === "role") {
    if (!roleId) return { ok: false, error: "No role was selected." };
    const result = await discordRequest(`/guilds/${guild}/members/${targetId}/roles/${roleId}`, {
      method: "PUT",
      headers,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  return { ok: false, error: `Unknown action type: ${type}` };
}

async function notifyModeration(action, targetName) {
  const { type, reason, durationMinutes, roleLabel, staffName, targetId, notify } = action;
  const title = `Player ${ACTION_LABEL[type]}`;
  const durationLine = type === "timeout" ? field("Duration", formatDuration(durationMinutes)) : null;
  const roleLine = type === "role" ? field("Role", roleLabel || "Unknown role") : null;

  await logToChannel(
    embed({
      color: COLOR[type],
      title,
      description: `**${targetName}** was ${ACTION_VERB[type]}`,
      fields: [field("By", staffName), durationLine, roleLine, field("Reason", reason, false)],
    })
  );

  if (notify && isRealDiscordId(targetId)) {
    await dmUser(
      targetId,
      embed({
        color: COLOR[type],
        title: `You were ${ACTION_VERB[type]}`,
        description: "A staff member took a moderation action on your Keizaal Online account.",
        fields: [field("By", staffName), durationLine, roleLine, field("Reason", reason, false)],
      })
    );
  }
}

function formatDuration(minutes) {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"}`;
  return `${Math.round(minutes / 1440)} day${Math.round(minutes / 1440) === 1 ? "" : "s"}`;
}

module.exports = {
  dmUser,
  logToChannel,
  isRealDiscordId,
  notifyTicketOpened,
  notifyReply,
  notifyClaimed,
  notifyClosed,
  notifyDecision,
  notifyParticipantAdded,
  applyModerationAction,
  notifyModeration,
  ticketUrl,
  playerUrl,
};
