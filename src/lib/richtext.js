const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRichText(raw) {
  const escaped = escapeHtml(raw);
  const linked = escaped.replace(LINK_RE, (_, label, url) => {
    return `<a class="kb-link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return linked.replace(/\n/g, "<br>");
}

function truncateRich(raw, maxLen) {
  const text = String(raw || "");
  LINK_RE.lastIndex = 0;
  let visibleLen = 0;
  let cut = text.length;
  let truncated = false;
  let lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(text))) {
    const plain = text.slice(lastIndex, match.index);
    if (visibleLen + plain.length > maxLen) {
      cut = lastIndex + (maxLen - visibleLen);
      truncated = true;
      break;
    }
    visibleLen += plain.length;
    if (visibleLen + match[1].length > maxLen) {
      cut = match.index;
      truncated = true;
      break;
    }
    visibleLen += match[1].length;
    lastIndex = LINK_RE.lastIndex;
  }
  if (!truncated) {
    const rest = text.slice(lastIndex);
    if (visibleLen + rest.length > maxLen) {
      cut = lastIndex + (maxLen - visibleLen);
      truncated = true;
    }
  }
  const slice = truncated ? text.slice(0, cut).trim() + "..." : text;
  return renderRichText(slice);
}

module.exports = { escapeHtml, renderRichText, truncateRich };
