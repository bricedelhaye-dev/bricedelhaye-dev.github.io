// Le Quai joue — fonctions communes au site public et au tableau de bord.
// Toutes les dates civiles sont interprétées dans le fuseau Europe/Paris.

export function parisParts(ts = Date.now()) {
  const date = new Date(ts);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(safe).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
}

export function parisHM(ts) {
  const p = parisParts(ts);
  return { h: Number(p.hour) % 24, m: Number(p.minute) };
}

export function timestampForParisDateTime(year, month, day, hour = 0, minute = 0, second = 0) {
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  let guess = target;
  for (let i = 0; i < 5; i += 1) {
    const p = parisParts(guess);
    const represented = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second)
    );
    const delta = target - represented;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

export function parisDateKey(ts = Date.now()) {
  const p = parisParts(ts);
  return `d${p.year}${p.month}${p.day}`;
}

export function todayEventKey() {
  return parisDateKey();
}

export function isSameParisDay(a, b) {
  return parisDateKey(a) === parisDateKey(b);
}

export function endOfParisDay(ts = Date.now()) {
  const p = parisParts(ts);
  const next = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 1));
  return timestampForParisDateTime(
    next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0
  );
}

export function formatClock(ts) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', hour: 'numeric', minute: '2-digit'
  }).formatToParts(new Date(Number(ts)));
  const hour = parts.find((x) => x.type === 'hour')?.value || '';
  const minute = parts.find((x) => x.type === 'minute')?.value || '00';
  return minute === '00' ? `${hour} h` : `${hour} h ${minute}`;
}

export function formatEvent(ts) {
  const label = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long',
    hour: 'numeric', minute: '2-digit'
  }).format(new Date(Number(ts)));
  return label.replace(/:(\d{2})/, (match, mm) => (mm === '00' ? ' h' : ` h ${mm}`));
}

export function active(entry) {
  return Boolean(entry && Number(entry.expiresAt) > Date.now());
}

export function nextOccurrence(baseTs) {
  const target = parisHM(baseTs);
  let occ = Number(baseTs);
  let guard = 0;
  while (occ + 8 * 3600_000 < Date.now() && guard < 120) {
    occ += 7 * 86400_000;
    const hm = parisHM(occ);
    const diff = (target.h - hm.h) * 60 + (target.m - hm.m);
    if (diff !== 0 && Math.abs(diff) <= 120) occ += diff * 60_000;
    guard += 1;
  }
  return occ;
}

export function effectiveEventAt(rdv) {
  const base = Number(rdv?.eventAt);
  if (!Number.isFinite(base)) return null;
  return rdv.repeatWeekly === true ? nextOccurrence(base) : base;
}

export function isCancelledOccurrence(rdv, occurrence = effectiveEventAt(rdv)) {
  const cancelledAt = Number(rdv?.cancelledOccurrenceAt);
  return Number.isFinite(cancelledAt) && Number.isFinite(Number(occurrence))
    && Math.abs(cancelledAt - Number(occurrence)) < 60_000;
}
