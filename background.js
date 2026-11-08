import {
  DAY_MS,
  DEFAULT_SETTINGS,
  MIN_DAY_SECONDS,
  QUICK_CHECK_SECONDS,
  dayKey,
  daysAgoKey,
  emptyDay,
  evaluate,
  hostnameOf,
  isNight,
  matchesSite,
  scoreDay,
  socialUsedToday,
} from './shared.js';

const TICK_ALARM = 'tick';
const IDLE_SECONDS = 60;
const MAX_SEGMENT_MS = 3 * 60 * 1000; // cap per update, in case the computer slept
const EVAL_EVERY_MS = 10 * 60 * 1000;
const KEEP_DAYS = 30;
const PAUSE_AFTER_EARLY_END_MS = DAY_MS;
const ICON = 'icons/icon128.png';
const COLOR_CALM = '#4F807C';
const COLOR_WARN = '#A8651F';

// Every state change runs through one queue so overlapping events can't
// overwrite each other's storage writes.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch((err) => console.error('[Dopamine Detox]', err));
  return run;
}

// ---- Listeners (registered synchronously so they survive worker restarts) ---

chrome.idle.setDetectionInterval(IDLE_SECONDS);
ensureAlarm().catch(console.error);

chrome.runtime.onInstalled.addListener(({ reason }) =>
  serial(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    await ensureAlarm();
    await refresh({ forceEval: true });
    if (reason === 'install') chrome.runtime.openOptionsPage();
  }),
);

chrome.runtime.onStartup.addListener(() => serial(() => refresh({ forceEval: true })));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) serial(() => refresh());
});

chrome.tabs.onActivated.addListener(() => serial(() => refresh()));

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (tab.active && (info.url || 'audible' in info)) serial(() => refresh());
});

chrome.windows.onFocusChanged.addListener(() => serial(() => refresh()));

chrome.idle.onStateChanged.addListener(() => serial(() => refresh()));

// Catch social sites before they load, including ones opened in background tabs.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  serial(() => guardNavigation(details.tabId, details.url));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = messageHandlers[msg?.type];
  if (!handler) return false;
  serial(() => handler(msg)).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // keep the channel open for the async response
});

// ---- Messages from the popup, options page and blocked page ----------------

const messageHandlers = {
  async snapshot() {
    await refresh();
    return snapshot();
  },

  async startDetox() {
    const s = await loadState();
    const now = Date.now();
    if (!s.detox.active) beginDetox(s, now, 'manual');
    await saveState(s);
    await updateBadge(s, now);
    return snapshot();
  },

  async endDetox() {
    const s = await loadState();
    const now = Date.now();
    if (s.detox.active) {
      s.detox = { active: false, endedEarlyAt: now };
      s.snoozeUntil = now + PAUSE_AFTER_EARLY_END_MS;
    }
    await saveState(s);
    await updateBadge(s, now);
    return snapshot();
  },

  async settingsChanged() {
    await refresh({ forceEval: true });
    return snapshot();
  },

  async resetData() {
    await chrome.storage.local.remove(['days', 'detox', 'evalState', 'snoozeUntil', 'notices']);
    await chrome.storage.session.clear();
    await refresh({ forceEval: true });
    return snapshot();
  },

  // Used by dev.html to load or restore test history. Runs inside the queue so a
  // tracking tick can't overwrite the new data with what it loaded a moment ago.
  async devReplaceData({ data }) {
    if (!isUnpacked()) throw new Error('Test data is only available when the extension is loaded unpacked.');
    const keys = ['days', 'detox', 'snoozeUntil', 'notices'];
    await chrome.storage.local.remove([...keys, 'evalState']);
    const next = Object.fromEntries(keys.filter((k) => data?.[k] !== undefined).map((k) => [k, data[k]]));
    await chrome.storage.local.set(next);
    await chrome.storage.session.clear();
    await refresh({ forceEval: true });
    return snapshot();
  },
};

// Store installs get an update_url added to their manifest; unpacked ones don't.
function isUnpacked() {
  return !('update_url' in chrome.runtime.getManifest());
}

// ---- State -----------------------------------------------------------------

async function loadState() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'days', 'detox', 'evalState', 'snoozeUntil', 'notices']),
    chrome.storage.session.get(['current', 'lastHost']),
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(local.settings || {}) },
    days: local.days || {},
    detox: local.detox || { active: false },
    evalState: local.evalState || null,
    snoozeUntil: local.snoozeUntil || 0,
    notices: local.notices || {},
    current: session.current || null, // { host, tabId, start, visitStart }
    lastHost: session.lastHost || null,
  };
}

async function saveState(s) {
  await chrome.storage.local.set({
    days: s.days,
    detox: s.detox,
    evalState: s.evalState,
    snoozeUntil: s.snoozeUntil,
    notices: s.notices,
  });
  await chrome.storage.session.set({ current: s.current, lastHost: s.lastHost });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

// ---- Core loop -------------------------------------------------------------

async function refresh({ forceEval = false } = {}) {
  const now = Date.now();
  const [s, target] = await Promise.all([loadState(), activeTarget()]);

  recordTime(s, target, now);
  const notices = runLifecycle(s, now, forceEval);
  await saveState(s);

  if (s.current && isBlocked(s, s.current.host, now)) {
    await redirectToBlocked(s.current.tabId, s.current.host);
  }
  await updateBadge(s, now);
  for (const [title, message] of notices) notify(title, message);
}

// What the person is looking at right now, or null if they're away.
async function activeTarget() {
  let win;
  try {
    win = await chrome.windows.getLastFocused();
  } catch {
    return null;
  }
  if (!win?.focused) return null;

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  const host = tab && hostnameOf(tab.url);
  if (!host) return null;

  const idle = await chrome.idle.queryState(IDLE_SECONDS);
  if (idle === 'locked') return null;
  if (idle === 'idle' && !tab.audible) return null; // watching a video still counts
  return { host, tabId: tab.id };
}

// Close out the running segment, then start a new one for `target`.
function recordTime(s, target, now) {
  const key = dayKey(new Date(now));
  const day = (s.days[key] ||= emptyDay());
  const { current, settings } = s;
  const newHost = target?.host || null;

  if (current) {
    const secs = Math.min(Math.max(0, now - current.start), MAX_SEGMENT_MS) / 1000;
    const social = matchesSite(current.host, settings.sites);
    day.total += secs;
    day.domains[current.host] = (day.domains[current.host] || 0) + secs;
    if (social) {
      day.highStim += secs;
      if (isNight(new Date(now), settings.nightStartHour, settings.nightEndHour)) day.night += secs;
      const visitEnded = current.host !== newHost;
      if (visitEnded && now - current.visitStart < QUICK_CHECK_SECONDS * 1000) day.shortChecks += 1;
    }
  }

  if (!newHost) {
    s.current = null;
  } else if (current && current.host === newHost) {
    s.current = { ...current, start: now, tabId: target.tabId };
  } else {
    if (s.lastHost && s.lastHost !== newHost) day.switches += 1;
    if (s.lastHost !== newHost && matchesSite(newHost, settings.sites)) day.checks += 1;
    s.current = { host: newHost, tabId: target.tabId, start: now, visitStart: now };
    s.lastHost = newHost;
  }

  const cutoff = daysAgoKey(KEEP_DAYS, now);
  for (const k of Object.keys(s.days)) if (k < cutoff) delete s.days[k];
}

// Re-score, start or finish detoxes, and collect notifications to show.
function runLifecycle(s, now, forceEval) {
  const notices = [];
  const key = dayKey(new Date(now));
  const { settings } = s;

  if (s.detox.active && now >= s.detox.endsAt) {
    notices.push([
      'Detox complete',
      `You finished a ${s.detox.lengthDays}-day detox. Social sites are open again.`,
    ]);
    s.detox = { active: false, completedAt: now };
  }

  const stale = !s.evalState || s.evalState.day !== key || now - s.evalState.at >= EVAL_EVERY_MS;
  if (forceEval || stale) s.evalState = { at: now, day: key, ...evaluate(s.days, settings, now) };

  const ev = s.evalState;
  if (!s.detox.active && ev.recommend && now >= s.snoozeUntil) {
    if (settings.autoDetox) {
      beginDetox(s, now, 'auto');
      notices.push([
        'Detox started',
        `Your baseline is ${ev.baseline}/100. Social sites are limited to ${settings.dailyBudgetMin} min a day for ${settings.detoxDays} days.`,
      ]);
    } else if (s.notices.suggested !== key) {
      s.notices.suggested = key;
      notices.push([
        'A detox is recommended',
        `Your baseline is ${ev.baseline}/100. Open Dopamine Detox to start one.`,
      ]);
    }
  }

  if (s.detox.active) {
    const left = settings.dailyBudgetMin * 60 - socialUsedToday(s.days[key], s.detox, key);
    if (left > 0 && left <= 5 * 60 && s.notices.warned !== key) {
      s.notices.warned = key;
      notices.push([
        '5 minutes of social time left',
        'After that, social sites stay closed until midnight.',
      ]);
    }
  }
  return notices;
}

function beginDetox(s, now, reason) {
  const key = dayKey(new Date(now));
  s.detox = {
    active: true,
    reason,
    startedAt: now,
    endsAt: now + s.settings.detoxDays * DAY_MS,
    lengthDays: s.settings.detoxDays,
    startDay: key,
    usedAtStart: s.days[key]?.highStim || 0,
    baselineAtStart: s.evalState?.baseline ?? null,
  };
}

// ---- Blocking --------------------------------------------------------------

function isBlocked(s, host, now) {
  if (!s.detox.active || !matchesSite(host, s.settings.sites)) return false;
  const key = dayKey(new Date(now));
  return socialUsedToday(s.days[key], s.detox, key) >= s.settings.dailyBudgetMin * 60;
}

async function guardNavigation(tabId, url) {
  const host = hostnameOf(url);
  if (!host) return;
  const s = await loadState();
  const now = Date.now();
  if (!isBlocked(s, host, now)) return;

  const key = dayKey(new Date(now));
  const day = (s.days[key] ||= emptyDay());
  day.blocked += 1;
  await chrome.storage.local.set({ days: s.days });
  await redirectToBlocked(tabId, host);
}

async function redirectToBlocked(tabId, host) {
  const url = chrome.runtime.getURL(`blocked.html?site=${encodeURIComponent(host)}`);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch {
    // The tab closed, or it's a prerender that isn't a real tab yet.
  }
}

// ---- UI surfaces -----------------------------------------------------------

async function updateBadge(s, now) {
  const key = dayKey(new Date(now));
  let text = '';
  let color = COLOR_CALM;
  if (s.detox.active) {
    const left = s.settings.dailyBudgetMin * 60 - socialUsedToday(s.days[key], s.detox, key);
    text = left > 0 ? `${Math.ceil(left / 60)}m` : '0';
    if (left <= 0) color = COLOR_WARN;
  } else if (s.evalState?.recommend && now >= s.snoozeUntil) {
    text = '!';
    color = COLOR_WARN;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function notify(title, message) {
  chrome.notifications
    .create({ type: 'basic', iconUrl: ICON, title, message, priority: 0 })
    .catch(() => {});
}

async function snapshot() {
  const s = await loadState();
  const now = Date.now();
  const key = dayKey(new Date(now));
  const today = { ...emptyDay(), ...(s.days[key] || {}) };

  const week = [];
  for (let i = 6; i >= 0; i--) {
    const k = daysAgoKey(i, now);
    const d = s.days[k];
    week.push({ key: k, baseline: d && d.total >= MIN_DAY_SECONDS ? scoreDay(d).baseline : null });
  }

  return {
    now,
    todayKey: key,
    settings: s.settings,
    today,
    detox: s.detox,
    evalState: s.evalState,
    snoozeUntil: s.snoozeUntil,
    socialUsed: socialUsedToday(today, s.detox, key),
    week,
  };
}
