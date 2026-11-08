// Shared by the service worker, popup, options page and blocked page.

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SITES = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'reddit.com',
  'youtube.com',
  'snapchat.com',
  'threads.net',
  'threads.com',
  'pinterest.com',
  'tumblr.com',
  'twitch.tv',
  'bsky.app',
  '9gag.com',
];

export const DEFAULT_SETTINGS = {
  sites: DEFAULT_SITES,
  dailyBudgetMin: 30, // social minutes allowed per day during a detox
  detoxBelow: 40, // recommend a detox when the baseline drops below this
  detoxDays: 3,
  autoDetox: true, // start automatically, or only recommend
  nightStartHour: 23,
  nightEndHour: 5,
};

// ---- Scoring model -------------------------------------------------------
//
// The "baseline" is 100 minus a weighted stimulation load built from five
// browsing signals. It is a behavioural heuristic, not a biological measure.

export const MIN_DAY_SECONDS = 20 * 60; // a day needs 20 active minutes to count
export const MIN_DAYS = 2; // days needed before recommending anything
export const WINDOW_DAYS = 3; // recent active days averaged together
export const LOOKBACK_DAYS = 7;
export const QUICK_CHECK_SECONDS = 90;

export const COMPONENTS = [
  { key: 'share', label: 'Share of browsing on social', weight: 0.35 },
  { key: 'volume', label: 'Time on social', weight: 0.25 },
  { key: 'checking', label: 'Checking habit', weight: 0.2 },
  { key: 'fragmentation', label: 'Tab hopping', weight: 0.1 },
  { key: 'lateNight', label: 'Late-night scrolling', weight: 0.1 },
];

// The value at which each signal counts as a full load.
export const CEILINGS = {
  sharePct: 50,
  socialMin: 180,
  opens: 40,
  switchesPerHour: 60,
  nightMin: 45,
};

export const STATUS_LABELS = {
  steady: 'Baseline steady',
  dipping: 'Baseline dipping',
  low: 'Baseline low',
};

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function emptyDay() {
  return {
    total: 0, // active seconds on any http(s) site
    highStim: 0, // active seconds on social sites
    night: 0, // social seconds inside the late-night window
    switches: 0, // changes from one site to another
    checks: 0, // separate visits to a social site
    shortChecks: 0, // social visits shorter than QUICK_CHECK_SECONDS
    blocked: 0, // navigations stopped by the detox
    domains: {}, // seconds per hostname
  };
}

export function scoreDay(day) {
  const d = { ...emptyDay(), ...day };
  const hours = Math.max(d.total / 3600, 0.25);
  const raw = {
    sharePct: d.total > 0 ? (d.highStim / d.total) * 100 : 0,
    socialMin: d.highStim / 60,
    opens: d.checks,
    quickChecks: d.shortChecks,
    switchesPerHour: d.switches / hours,
    nightMin: d.night / 60,
  };
  const parts = {
    share: clamp01(raw.sharePct / CEILINGS.sharePct),
    volume: clamp01(raw.socialMin / CEILINGS.socialMin),
    // Quick in-and-out visits are the strongest sign of compulsive checking.
    checking: clamp01((raw.opens + raw.quickChecks * 0.5) / CEILINGS.opens),
    fragmentation: clamp01(raw.switchesPerHour / CEILINGS.switchesPerHour),
    lateNight: clamp01(raw.nightMin / CEILINGS.nightMin),
  };
  const load = COMPONENTS.reduce((sum, c) => sum + parts[c.key] * c.weight, 0);
  return { baseline: Math.round(100 * (1 - load)), parts, raw };
}

export function statusFor(baseline, detoxBelow) {
  if (baseline < detoxBelow) return 'low';
  if (baseline < detoxBelow + 20) return 'dipping';
  return 'steady';
}

export function evaluate(days, settings, now = Date.now()) {
  const cutoff = daysAgoKey(LOOKBACK_DAYS - 1, now);
  const used = Object.keys(days)
    .filter((k) => k >= cutoff && days[k].total >= MIN_DAY_SECONDS)
    .sort()
    .reverse()
    .slice(0, WINDOW_DAYS);

  if (used.length === 0) {
    return {
      calibrating: true,
      daysNeeded: MIN_DAYS,
      daysUsed: 0,
      baseline: null,
      parts: null,
      raw: null,
      status: null,
      recommend: false,
    };
  }

  const scored = used.map((k) => scoreDay(days[k]));
  const average = (pick) =>
    Object.fromEntries(
      Object.keys(pick(scored[0])).map((key) => [key, mean(scored.map((s) => pick(s)[key]))]),
    );
  const baseline = Math.round(mean(scored.map((s) => s.baseline)));
  const calibrating = used.length < MIN_DAYS;

  return {
    calibrating,
    daysNeeded: Math.max(0, MIN_DAYS - used.length),
    daysUsed: used.length,
    baseline,
    parts: average((s) => s.parts),
    raw: average((s) => s.raw),
    status: statusFor(baseline, settings.detoxBelow),
    recommend: !calibrating && baseline < settings.detoxBelow,
  };
}

// Social seconds that count against today's budget. On the day a detox starts,
// time spent before it started doesn't count.
export function socialUsedToday(day, detox, key) {
  const used = day?.highStim || 0;
  if (detox?.active && detox.startDay === key) return Math.max(0, used - (detox.usedAtStart || 0));
  return used;
}

// ---- Dates ----------------------------------------------------------------

export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysAgoKey(n, now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return dayKey(d);
}

export function isNight(date, startHour, endHour) {
  const h = date.getHours();
  if (startHour === endHour) return false;
  return startHour > endHour ? h >= startHour || h < endHour : h >= startHour && h < endHour;
}

// ---- Sites ----------------------------------------------------------------

export function hostnameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function normalizeSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '');
  s = s.split(/[/?#:\s]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

export function matchesSite(host, sites) {
  if (!host) return false;
  return sites.some((s) => host === s || host.endsWith(`.${s}`));
}

// ---- Formatting -----------------------------------------------------------

export function formatDuration(seconds) {
  const m = Math.round((seconds || 0) / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
