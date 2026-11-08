import { MIN_DAY_SECONDS, STATUS_LABELS, daysAgoKey, evaluate, formatWhen, getSettings, scoreDay } from './shared.js';
import { SCENARIOS, buildHistory, nearLimitDetox } from './dev-data.js';

const $ = (sel) => document.querySelector(sel);
const BACKUP_KEYS = ['days', 'detox', 'snoozeUntil', 'notices'];
let settings;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...[].concat(children));
  return node;
}

const status = (text, isError = false) => {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', isError);
};

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res || res.error) throw new Error(res?.error || 'The extension didn’t respond. Reload it on chrome://extensions.');
  return res;
}

// ---- Previews -------------------------------------------------------------

function predictionText(days) {
  const ev = evaluate(days, settings);
  if (ev.baseline == null) return 'No reading.';
  if (ev.calibrating) {
    const more = ev.daysNeeded === 1 ? '1 more day' : `${ev.daysNeeded} more days`;
    return `Early reading of ${ev.baseline}. Needs ${more} before it can call for a detox.`;
  }
  const label = STATUS_LABELS[ev.status].replace('Baseline ', '');
  let detox = 'No detox.';
  if (ev.recommend) detox = settings.autoDetox ? 'A detox starts automatically.' : 'A detox is recommended.';
  return `Baseline ${ev.baseline}, ${label}. ${detox}`;
}

function weekStrip(days) {
  const now = Date.now();
  return el(
    'div',
    { className: 'week', ariaHidden: 'true' },
    Array.from({ length: 7 }, (_, i) => {
      const ago = 6 - i;
      const key = daysAgoKey(ago, now);
      const d = days[key];
      const baseline = d && d.total >= MIN_DAY_SECONDS ? scoreDay(d).baseline : null;
      const glass = el('div', { className: 'mini' }, [el('span')]);
      if (baseline == null) glass.dataset.empty = '';
      else {
        glass.style.setProperty('--level', `${baseline}%`);
        if (baseline < settings.detoxBelow) glass.dataset.low = '';
      }
      const [y, m, dd] = key.split('-').map(Number);
      const label = ago === 0 ? 'Today' : new Date(y, m - 1, dd).toLocaleDateString(undefined, { weekday: 'short' });
      return el('div', { className: ago === 0 ? 'today' : '' }, [glass, el('small', { textContent: label })]);
    }),
  );
}

function renderScenarios() {
  $('#scenarios').replaceChildren(
    ...SCENARIOS.map((s, i) => {
      const days = buildHistory(s.id, settings);
      const radio = el('input', { type: 'radio', name: 'scenario', value: s.id, checked: i === 0 });
      return el('label', { className: 'scenario' }, [
        radio,
        el('div', {}, [
          el('p', { className: 'name', textContent: s.name }),
          el('p', { className: 'desc', textContent: s.description }),
          weekStrip(days),
          el('p', { className: 'predict', textContent: predictionText(days) }),
        ]),
      ]);
    }),
  );
}

async function renderBackupNote() {
  const { devBackup } = await chrome.storage.local.get('devBackup');
  $('#backup-note').hidden = !devBackup;
  if (devBackup) {
    $('#backup-text').textContent = `Test data is loaded. Your real history was saved on ${formatWhen(devBackup.savedAt)}. Anything tracked since then is discarded when you restore.`;
  }
}

// ---- Actions --------------------------------------------------------------

async function backUpRealData() {
  const stored = await chrome.storage.local.get(['devBackup', ...BACKUP_KEYS]);
  if (stored.devBackup) return; // already holding the real data; don't overwrite it with test data
  const backup = { savedAt: Date.now() };
  for (const k of BACKUP_KEYS) if (stored[k] !== undefined) backup[k] = stored[k];
  await chrome.storage.local.set({ devBackup: backup });
}

async function withButtons(fn) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    status(err.message, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    await renderBackupNote();
  }
}

$('#load').addEventListener('click', () =>
  withButtons(async () => {
    const id = document.querySelector('input[name="scenario"]:checked')?.value;
    const scenario = SCENARIOS.find((s) => s.id === id);
    settings = await getSettings();
    const days = buildHistory(id, settings);
    const data = { days };
    const nearLimit = $('#near-limit').checked;
    if (nearLimit) data.detox = nearLimitDetox(days, settings, evaluate(days, settings).baseline);

    await backUpRealData();
    const snap = await send('devReplaceData', { data });

    const ev = snap.evalState;
    const reading = ev?.baseline == null ? 'No reading yet.' : `Baseline ${ev.baseline}.`;
    let detox = 'No detox is running.';
    if (snap.detox.active) {
      detox = nearLimit
        ? settings.dailyBudgetMin === 0
          ? 'A detox is running and social sites are closed.'
          : 'A detox is running with 1 minute of social time left. Open a social site to test blocking.'
        : 'A detox started automatically.';
    }
    status(`Loaded “${scenario.name}”. ${reading} ${detox} Open the popup to see it.`);
  }),
);

$('#clear').addEventListener('click', () =>
  withButtons(async () => {
    if (!confirm('Clear all history and end any detox? Your saved real data, if any, is kept.')) return;
    await backUpRealData();
    await send('devReplaceData', { data: {} });
    status('All data cleared. The extension is back to a fresh install.');
  }),
);

$('#restore').addEventListener('click', () =>
  withButtons(async () => {
    const { devBackup } = await chrome.storage.local.get('devBackup');
    if (!devBackup) return;
    const { savedAt, ...data } = devBackup;
    await send('devReplaceData', { data });
    await chrome.storage.local.remove('devBackup');
    status('Your real data is back.');
  }),
);

// ---- Start ----------------------------------------------------------------

async function init() {
  if ('update_url' in chrome.runtime.getManifest()) {
    $('main').replaceChildren(
      el('h1', { textContent: 'Test data' }),
      el('p', { className: 'intro', textContent: 'Test data is only available when the extension is loaded unpacked.' }),
    );
    return;
  }
  settings = await getSettings();
  if (settings.dailyBudgetMin === 0) {
    $('#near-limit-text').textContent =
      'Start a detox now. Your daily allowance is 0, so social sites will be closed right away.';
  }
  renderScenarios();
  await renderBackupNote();
}

init();
