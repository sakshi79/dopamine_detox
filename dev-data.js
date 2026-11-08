// Builds realistic fake browsing history for testing. Pure functions only, so the
// dev page can preview a scenario and load exactly what it previewed.

import { dayKey, daysAgoKey, emptyDay } from './shared.js';

const OTHER_SITES = [
  'github.com',
  'docs.google.com',
  'mail.google.com',
  'news.ycombinator.com',
  'en.wikipedia.org',
  'stackoverflow.com',
  'notion.so',
  'calendar.google.com',
];
const PREFERRED_SOCIAL = ['reddit.com', 'youtube.com', 'instagram.com', 'tiktok.com', 'x.com'];

// Per-day habits. Minutes are for a full day; "quick" is the share of opens under 90 seconds.
const PROFILES = {
  balanced: { socialMin: 25, otherMin: 220, opens: 8, quick: 0.25, switchesPerHour: 15, nightMin: 0 },
  edge: { socialMin: 90, otherMin: 190, opens: 28, quick: 0.3, switchesPerHour: 30, nightMin: 15 },
  heavy: { socialMin: 140, otherMin: 150, opens: 45, quick: 0.4, switchesPerHour: 40, nightMin: 30 },
};

const mix = (a, b, t) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] - a[k]) * t]));

// Oldest day first; the last entry is today. null means no browsing that day.
export const SCENARIOS = [
  {
    id: 'heavy',
    name: 'Heavy scroller',
    description: 'A week of more than two hours a day on social, lots of quick checks and some late nights.',
    week: () => Array(7).fill(PROFILES.heavy),
  },
  {
    id: 'sliding',
    name: 'Sliding',
    description: 'Starts the week balanced and gets steadily worse, so the 7-day view shows a trend.',
    week: () => Array.from({ length: 7 }, (_, i) => mix(PROFILES.balanced, PROFILES.heavy, i / 6)),
  },
  {
    id: 'edge',
    name: 'On the edge',
    description: 'Hovers near the default detox line. Useful for trying different threshold settings.',
    week: () => Array(7).fill(PROFILES.edge),
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Under half an hour of social a day. No detox.',
    week: () => Array(7).fill(PROFILES.balanced),
  },
  {
    id: 'first-day',
    name: 'First day',
    description: 'One heavy day, as if just installed. Shows an early reading before it can call for a detox.',
    week: () => [null, null, null, null, null, null, PROFILES.heavy],
  },
];

// Small seeded random generator, so the same scenario always produces the same data.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const vary = (r, x, amount = 0.15) => x * (1 - amount + r() * 2 * amount);

function pick(list, n, r) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// Split `seconds` across hosts with uneven weights.
function spread(domains, seconds, hosts, r) {
  if (!hosts.length || seconds <= 0) return;
  const weights = hosts.map(() => 0.3 + r());
  const sum = weights.reduce((a, b) => a + b, 0);
  let left = seconds;
  hosts.forEach((host, i) => {
    const share = i === hosts.length - 1 ? left : Math.round((seconds * weights[i]) / sum);
    domains[host] = (domains[host] || 0) + share;
    left -= share;
  });
}

function socialHostsFor(settings) {
  const preferred = PREFERRED_SOCIAL.filter((s) => settings.sites.includes(s));
  return preferred.length ? preferred : settings.sites.slice(0, 4);
}

function buildDay(profile, r, socialHosts, { today }) {
  const scale = today ? 0.6 : 1; // today is only partly over
  const social = socialHosts.length ? Math.round(vary(r, profile.socialMin * 60 * scale)) : 0;
  const other = Math.round(vary(r, profile.otherMin * 60 * scale));
  const total = social + other;
  const checks = Math.round(vary(r, profile.opens * scale));
  const day = emptyDay();

  spread(day.domains, social, pick(socialHosts, 3, r), r);
  spread(day.domains, other, pick(OTHER_SITES, 4, r), r);

  return {
    ...day,
    total,
    highStim: social,
    night: today ? 0 : Math.min(social, Math.round(vary(r, profile.nightMin * 60))),
    switches: Math.round(vary(r, (profile.switchesPerHour * total) / 3600)),
    checks,
    shortChecks: Math.round(checks * profile.quick),
  };
}

// Returns a `days` object keyed by date, ending today.
export function buildHistory(scenarioId, settings, now = Date.now()) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  const r = random([...scenarioId].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261));
  const socialHosts = socialHostsFor(settings);
  const week = scenario.week();
  const days = {};
  week.forEach((profile, i) => {
    if (!profile) return;
    const ago = week.length - 1 - i;
    days[daysAgoKey(ago, now)] = buildDay(profile, r, socialHosts, { today: ago === 0 });
  });
  return days;
}

// Rewrites today so exactly one minute of social allowance is left, and returns a
// detox that's already running. Mutates `days`.
export function nearLimitDetox(days, settings, baseline, now = Date.now()) {
  const key = dayKey(new Date(now));
  const day = (days[key] ||= emptyDay());
  const target = Math.max(0, settings.dailyBudgetMin * 60 - 60);
  const socialHosts = Object.keys(day.domains).filter((h) =>
    settings.sites.some((s) => h === s || h.endsWith(`.${s}`)),
  );

  if (day.highStim > 0 && socialHosts.length) {
    const factor = target / day.highStim;
    let left = target;
    socialHosts.forEach((h, i) => {
      const secs = i === socialHosts.length - 1 ? left : Math.round(day.domains[h] * factor);
      day.domains[h] = secs;
      left -= secs;
    });
  } else if (target > 0) {
    const host = socialHostsFor(settings)[0] || 'reddit.com';
    day.domains[host] = (day.domains[host] || 0) + target;
  }
  day.total += target - day.highStim;
  day.highStim = target;
  day.night = Math.min(day.night, target);

  const startedAt = now - 60 * 60 * 1000;
  return {
    active: true,
    reason: 'manual',
    startedAt,
    endsAt: startedAt + settings.detoxDays * 24 * 60 * 60 * 1000,
    lengthDays: settings.detoxDays,
    startDay: dayKey(new Date(startedAt)),
    usedAtStart: 0, // count all of today's social time against the allowance
    baselineAtStart: baseline,
  };
}
