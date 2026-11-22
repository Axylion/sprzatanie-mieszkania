const warsawDateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
function partsInWarsaw(timestamp) {
  const parts = warsawDateParts.formatToParts(new Date(timestamp));
  return ["year", "month", "day", "hour", "minute", "second"]
    .map(type => Number(parts.find(part => part.type === type).value));
}
// ISO z offsetem oznacza konkretną chwilę. Bez offsetu używamy Europe/Warsaw,
// niezależnie od strefy urządzenia. Sama data expiresAt jest ważna do końca dnia.
function parseAnnouncementDate(value, endOfDay = false) {
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return NaN;
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  const parts = [Number(y), Number(m), Number(d), Number(h || 0), Number(min || 0), Number(sec || 0)];
  const [year, month, day, hour, minute, second] = parts;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (year < 100 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return NaN;
  if (zone) return Date.parse(value);
  let local = parts;
  let localWall = wall;
  if (!h && endOfDay) {
    const next = new Date(wall + 86400000);
    local = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0];
    localWall += 86400000;
  }
  // Offset przed/po granicy wykrywa CET/CEST także w dniu zmiany czasu.
  const candidates = [-36, 0, 36].map(hours => {
    const sample = localWall + hours * 3600000;
    const [sy, sm, sd, sh, smin, ss] = partsInWarsaw(sample);
    const offset = Date.UTC(sy, sm - 1, sd, sh, smin, ss) - sample;
    return localWall - offset;
  }).filter(candidate => partsInWarsaw(candidate).every((part, index) => part === local[index]));
  // Nieistniejący czas wiosną jest odrzucany; jesienią wybieramy wcześniejszą chwilę.
  return candidates.length ? Math.min(...candidates) + Number((fraction || "").padEnd(3, "0")) : NaN;
}
export function announcementsForInbox(items) {
  if (!Array.isArray(items)) throw new TypeError("Expected announcements array");
  return items.flatMap(item => {
    const published = parseAnnouncementDate(item?.publishedAt);
    const expires = item?.expiresAt == null ? null : parseAnnouncementDate(item.expiresAt, true);
    if (typeof item?.id !== "string" || !item.id || typeof item.title !== "string" ||
        typeof item.body !== "string" || !Number.isFinite(published) ||
        (expires !== null && !Number.isFinite(expires))) return [];
    return [{ id: item.id, title: item.title, summary: announcementText(item.body, 160),
      published: new Date(published).toISOString(),
      expires: expires === null ? null : new Date(expires).toISOString() }];
  });
}

export function deliveryOutcome(status) {
  if (status === 404 || status === 410) return "gone";
  if (!status || status === 408 || status === 429 || status >= 500) return "retry";
  return "failed";
}

const graphemes = new Intl.Segmenter("pl", { granularity: "grapheme" });
const polishDate = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
});

function announcementText(value, limit) {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  let clipped = "";
  let count = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    if (count >= limit || clipped.length + segment.length > 400) {
      if (!clipped) return "";
      const boundary = clipped.lastIndexOf(" ");
      if (text[index] !== " " && !clipped.endsWith(" ") && boundary > 0) {
        clipped = clipped.slice(0, boundary);
      }
      return clipped.trimEnd() + "…";
    }
    clipped += segment;
    count++;
  }
  return clipped;
}

function dutyText(value) {
  // The persisted key is a Warsaw calendar date. Use UTC for calendar arithmetic.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const saturday = new Date(value + "T00:00:00Z");
  if (saturday.getUTCDay() !== 6 || !saturday.toISOString().startsWith(value + "T")) return null;
  const sunday = new Date(saturday);
  sunday.setUTCDate(sunday.getUTCDate() + 1);
  const period = saturday.getUTCMonth() === sunday.getUTCMonth()
    ? saturday.getUTCDate() + "–" + polishDate.format(sunday)
    : polishDate.format(saturday) + " – " + polishDate.format(sunday);
  return "Twój dyżur: " + period + " (sobota–niedziela).";
}

export function pushPayload(item) {
  const payload = { id: item.id, category: item.category, target: item.target };
  if (item.category === "messages" && item.kind === "private") {
    return { ...payload, kind: "private", room: item.room,
      body: [1,2,3,4].includes(item.room) ? "Nowa wiadomość prywatna od pokoju nr " + item.room : "Nowa wiadomość prywatna" };
  }
  if (item.category === "duties") {
    return { ...payload, body: dutyText(item.duty_saturday) || "Sprawdź harmonogram sprzątania." };
  }
  if (item.category === "announcements") {
    return { ...payload, title: announcementText(item.announcement_title, 100),
      body: announcementText(item.announcement_summary, 160) };
  }
  if (item.category !== "messages" || ![1, 2, 3, 4].includes(item.room) || typeof item.message !== "string") {
    return payload;
  }
  const normalized = item.message.replace(/\s+/gu, " ").trim();
  let preview = "";
  let count = 0;
  for (const { segment } of graphemes.segment(normalized)) {
    // Cap both visible characters and the size of unusually large graphemes.
    if (count >= 140 || preview.length + segment.length > 400) {
      preview = preview.trimEnd() + "…";
      break;
    }
    preview += segment;
    count++;
  }
  return { ...payload, room: item.room, preview };
}
