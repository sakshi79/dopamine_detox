import { DEFAULT_SITES, getSettings, normalizeSite } from './shared.js';

const $ = (sel) => document.querySelector(sel);
let current;
let locked = false;

function hourLabel(h) {
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
}

function fillHours(select) {
  select.replaceChildren(
    ...Array.from({ length: 24 }, (_, h) => new Option(hourLabel(h), String(h))),
  );
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function showStatus(text) {
  $('#status').textContent = text;
}

async function init() {
  fillHours($('#night-start'));
  fillHours($('#night-end'));

  current = await getSettings();
  const { detox } = await chrome.storage.local.get('detox');
  locked = !!detox?.active;

  $('#detox-below').value = current.detoxBelow;
  $('#detox-below-out').value = current.detoxBelow;
  $('#budget').value = current.dailyBudgetMin;
  $('#days').value = current.detoxDays;
  $('#auto').checked = current.autoDetox;
  $('#sites').value = current.sites.join('\n');
  $('#night-start').value = String(current.nightStartHour);
  $('#night-end').value = String(current.nightEndHour);

  // Store installs get an update_url in their manifest; unpacked copies don't.
  $('#dev-group').hidden = 'update_url' in chrome.runtime.getManifest();

  if (locked) {
    $('#lock-note').hidden = false;
    for (const id of ['#sites', '#budget', '#restore-sites', '#reset']) $(id).disabled = true;
  }
}

$('#detox-below').addEventListener('input', (e) => {
  $('#detox-below-out').value = e.target.value;
});

$('#restore-sites').addEventListener('click', () => {
  $('#sites').value = DEFAULT_SITES.join('\n');
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const lines = $('#sites').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const sites = [...new Set(lines.map(normalizeSite).filter(Boolean))];
  const skipped = lines.filter((s) => !normalizeSite(s));

  const next = {
    ...current,
    detoxBelow: clampInt($('#detox-below').value, 10, 90, current.detoxBelow),
    detoxDays: clampInt($('#days').value, 1, 14, current.detoxDays),
    autoDetox: $('#auto').checked,
    nightStartHour: clampInt($('#night-start').value, 0, 23, current.nightStartHour),
    nightEndHour: clampInt($('#night-end').value, 0, 23, current.nightEndHour),
    sites: locked ? current.sites : sites,
    dailyBudgetMin: locked ? current.dailyBudgetMin : clampInt($('#budget').value, 0, 480, current.dailyBudgetMin),
  };

  await chrome.storage.local.set({ settings: next });
  current = next;
  $('#sites').value = next.sites.join('\n');
  $('#budget').value = next.dailyBudgetMin;
  $('#days').value = next.detoxDays;

  try {
    await chrome.runtime.sendMessage({ type: 'settingsChanged' });
  } catch {
    // The service worker will pick up the new settings on its next tick.
  }

  showStatus(
    skipped.length && !locked
      ? `Saved. Skipped ${skipped.length} ${skipped.length === 1 ? 'entry that isn’t' : 'entries that aren’t'} a domain: ${skipped.join(', ')}.`
      : 'Saved.',
  );
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Delete all tracked browsing data? Your settings stay. This can’t be undone.')) return;
  await chrome.runtime.sendMessage({ type: 'resetData' });
  showStatus('Browsing data deleted.');
});

init();
