import {
  COMPONENTS,
  DAY_MS,
  MIN_DAYS,
  STATUS_LABELS,
  formatDuration,
  formatWhen,
  matchesSite,
} from './shared.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...[].concat(children));
  return node;
}

function button(label, variant, onClick) {
  const b = el('button', { type: 'button', className: variant, textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

let snap = null;
let firstPaint = true;

async function call(type) {
  const res = await chrome.runtime.sendMessage({ type });
  if (!res || res.error) throw new Error(res?.error || 'The extension didn’t respond.');
  return res;
}

async function load(type = 'snapshot') {
  try {
    snap = await call(type);
    render();
  } catch (err) {
    $('#status').textContent = 'Couldn’t load your data';
    $('#hint').className = 'hint error';
    $('#hint').textContent = `${err.message} Close and reopen this popup to try again.`;
  }
}

function render() {
  renderGauge();
  renderDetox();
  renderDrivers();
  renderToday();
  renderWeek();
}

// ---- Gauge ----------------------------------------------------------------

function renderGauge() {
  const { evalState: ev, settings } = snap;
  const baseline = ev?.baseline ?? null;
  const glass = $('#glass');

  $('#hero').dataset.state = ev?.status || 'unknown';
  glass.style.setProperty('--threshold', `${settings.detoxBelow}%`);
  glass.setAttribute(
    'aria-label',
    baseline == null ? 'No reading yet' : `Baseline ${baseline} out of 100. Detox threshold ${settings.detoxBelow}.`,
  );

  // Fill from empty on open, then animate between readings.
  const setLevel = () => glass.style.setProperty('--level', `${baseline ?? 0}%`);
  if (firstPaint) {
    firstPaint = false;
    requestAnimationFrame(() => requestAnimationFrame(setLevel));
  } else {
    setLevel();
  }

  if (baseline == null) {
    $('#status').textContent = 'Learning your patterns';
    $('#score').textContent = 'No reading yet';
    $('#hint').textContent = `Browse as usual. A reading needs ${MIN_DAYS} days with at least 20 minutes of browsing.`;
    return;
  }

  $('#status').textContent = ev.calibrating ? 'Early reading' : STATUS_LABELS[ev.status];
  $('#score').textContent = `${baseline} out of 100`;
  $('#hint').textContent = ev.calibrating
    ? `Based on 1 day. It needs ${ev.daysNeeded} more before it can call for a detox.`
    : `Average of your last ${ev.daysUsed} active days. A detox starts below ${settings.detoxBelow}, the dashed line.`;
}

// ---- Detox ----------------------------------------------------------------

function renderDetox() {
  const box = $('#detox');
  box.replaceChildren();
  const { detox, settings, evalState: ev, socialUsed, now, snoozeUntil } = snap;

  if (detox.active) {
    const dayNum = Math.min(detox.lengthDays, Math.floor((now - detox.startedAt) / DAY_MS) + 1);
    const budget = settings.dailyBudgetMin * 60;
    const left = Math.max(0, budget - socialUsed);
    box.append(
      el('h2', { textContent: `Detox, day ${dayNum} of ${detox.lengthDays}` }),
      el('div', { className: 'meter-row' }, [
        el('span', { textContent: 'Social time today' }),
        el('span', {
          className: 'muted',
          textContent: `${formatDuration(Math.min(socialUsed, budget))} of ${formatDuration(budget)}`,
        }),
      ]),
      meter(socialUsed, budget),
      el('p', {
        textContent:
          left > 0
            ? `${formatDuration(left)} left. After that, social sites close until midnight.`
            : 'Social sites are closed until midnight.',
      }),
      el('p', { className: 'muted', textContent: `Ends ${formatWhen(detox.endsAt)}.` }),
      endEarlyControl(),
    );
    return;
  }

  if (ev?.recommend && now >= snoozeUntil) {
    box.append(
      el('h2', { textContent: 'A detox is recommended' }),
      el('p', {
        textContent: `For ${settings.detoxDays} days, social sites get ${settings.dailyBudgetMin} minutes a day. Everything else stays open.`,
      }),
      button(`Start ${settings.detoxDays}-day detox`, 'primary', () => load('startDetox')),
    );
    return;
  }

  let message;
  if (now < snoozeUntil) {
    message = `You ended a detox early. Automatic detoxes are paused until ${formatWhen(snoozeUntil)}.`;
  } else if (ev?.baseline == null || ev.calibrating) {
    message = 'No call yet. It’s still learning how you browse.';
  } else {
    message = 'No detox needed right now. Social sites are unrestricted.';
  }
  box.append(
    el('h2', { textContent: 'Detox' }),
    el('p', { textContent: message }),
    button(`Start a ${settings.detoxDays}-day detox anyway`, '', () => load('startDetox')),
  );
}

function meter(used, budget) {
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 100;
  const m = el('div', { className: 'meter' }, [el('span')]);
  m.firstChild.style.width = `${pct}%`;
  m.setAttribute('role', 'progressbar');
  m.setAttribute('aria-label', 'Social time used today');
  m.setAttribute('aria-valuemin', '0');
  m.setAttribute('aria-valuemax', '100');
  m.setAttribute('aria-valuenow', String(Math.round(pct)));
  if (pct >= 100) m.dataset.full = '';
  return m;
}

function endEarlyControl() {
  const phrase = 'end my detox';
  const input = el('input', { type: 'text', id: 'end-phrase', autocomplete: 'off', spellcheck: false });
  const confirm = button('End detox', 'danger', () => load('endDetox'));
  confirm.disabled = true;
  input.addEventListener('input', () => {
    confirm.disabled = input.value.trim().toLowerCase() !== phrase;
  });
  return el('details', { className: 'end-early' }, [
    el('summary', { textContent: 'End detox early' }),
    el('p', { className: 'muted', textContent: 'Automatic detoxes pause for 24 hours afterward.' }),
    el('label', { htmlFor: 'end-phrase', textContent: `Type “${phrase}” to confirm` }),
    el('div', { className: 'row' }, [input, confirm]),
  ]);
}

// ---- Drivers --------------------------------------------------------------

const DRIVER_VALUES = {
  share: (r) => `${Math.round(r.sharePct)}% of browsing`,
  volume: (r) => `${formatDuration(r.socialMin * 60)} a day`,
  checking: (r) => `${Math.round(r.opens)} opens a day`,
  fragmentation: (r) => `${Math.round(r.switchesPerHour)} switches an hour`,
  lateNight: (r) => `${formatDuration(r.nightMin * 60)} a night`,
};

function renderDrivers() {
  const ev = snap.evalState;
  const section = $('#drivers-section');
  if (!ev?.parts) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const ranked = [...COMPONENTS].sort(
    (a, b) => ev.parts[b.key] * b.weight - ev.parts[a.key] * a.weight,
  );
  $('#drivers').replaceChildren(
    ...ranked.map((c) => {
      const part = ev.parts[c.key];
      const bar = el('div', { className: 'bar' }, [el('span')]);
      bar.firstChild.style.width = `${Math.round(part * 100)}%`;
      if (part > 0.66) bar.dataset.high = '';
      return el('li', {}, [
        el('div', { className: 'line' }, [
          el('span', { textContent: c.label }),
          el('span', { className: 'value', textContent: DRIVER_VALUES[c.key](ev.raw) }),
        ]),
        bar,
      ]);
    }),
  );
}

// ---- Today ----------------------------------------------------------------

function renderToday() {
  const { today: t, detox, settings } = snap;
  const stats = [
    ['Browsing', formatDuration(t.total)],
    ['On social', formatDuration(t.highStim)],
    ['Social opens', String(t.checks)],
    ['Quick checks', String(t.shortChecks)],
    ['Site switches', String(t.switches)],
    detox.active ? ['Blocked', String(t.blocked)] : ['Late night', formatDuration(t.night)],
  ];
  $('#stats').replaceChildren(
    ...stats.map(([label, value]) =>
      el('div', {}, [el('dt', { textContent: label }), el('dd', { textContent: value })]),
    ),
  );

  const top = Object.entries(t.domains)
    .sort((a, b) => b[1] - a[1])
    .filter(([, secs]) => secs >= 30)
    .slice(0, 5);
  const list = $('#sites');
  if (top.length === 0) {
    list.replaceChildren(el('li', { className: 'muted', textContent: 'Nothing tracked yet today.' }));
    list.nextElementSibling?.remove();
    return;
  }
  list.replaceChildren(
    ...top.map(([host, secs]) => {
      const social = matchesSite(host, settings.sites);
      const name = el('span', { className: 'name', textContent: host });
      if (social) name.append(el('span', { className: 'sr-only', textContent: ' (social)' }));
      return el('li', { className: social ? 'social' : '' }, [
        name,
        el('span', { className: 'muted', textContent: formatDuration(secs) }),
      ]);
    }),
  );
  if (top.some(([host]) => matchesSite(host, settings.sites)) && !$('.sites-key')) {
    list.after(el('p', { className: 'sites-key muted', textContent: 'Dotted sites count as social.' }));
  }
}

// ---- Week -----------------------------------------------------------------

function renderWeek() {
  const { week, todayKey, settings } = snap;
  $('#week').replaceChildren(
    ...week.map(({ key, baseline }) => {
      const [y, m, d] = key.split('-').map(Number);
      const label = key === todayKey
        ? 'Today'
        : new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
      const glass = el('div', { className: 'mini' }, [el('span')]);
      if (baseline == null) {
        glass.dataset.empty = '';
      } else {
        glass.style.setProperty('--level', `${baseline}%`);
        if (baseline < settings.detoxBelow) glass.dataset.low = '';
      }
      const cell = el('div', { className: key === todayKey ? 'today' : '' }, [glass, el('small', { textContent: label })]);
      cell.title = baseline == null ? `${label}: not enough browsing to score` : `${label}: baseline ${baseline}`;
      return cell;
    }),
  );
}

$('#open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

load();
