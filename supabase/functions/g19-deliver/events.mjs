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
    return [{ id: item.id, title: item.title, published: new Date(published).toISOString(),
      expires: expires === null ? null : new Date(expires).toISOString() }];
  });
}

export function deliveryOutcome(status) {
  if (status === 404 || status === 410) return "gone";
  if (!status || status === 408 || status === 429 || status >= 500) return "retry";
  return "failed";
}
