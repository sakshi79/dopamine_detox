import { DAY_MS, formatDuration, formatWhen, matchesSite, normalizeSite } from './shared.js';

const $ = (sel) => document.querySelector(sel);
const site = normalizeSite(new URLSearchParams(location.search).get('site'));
const siteName = site || 'That site';

$('#close').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) chrome.tabs.remove(tab.id);
  else window.close();
});

async function init() {
  let snap;
  try {
    snap = await chrome.runtime.sendMessage({ type: 'snapshot' });
  } catch {
    snap = null;
  }
  if (!snap || snap.error) {
    $('#lede').textContent = `${siteName} is limited during your detox.`;
    return;
  }

  const { settings, detox, socialUsed, now } = snap;
  const budget = settings.dailyBudgetMin * 60;
  const stillBlocked = detox.active && site && matchesSite(site, settings.sites) && socialUsed >= budget;

  if (!stillBlocked) {
    document.title = 'This site is open again';
    $('#heading').textContent = 'This site is open again';
    $('#lede').textContent = 'Your daily limit has reset or your detox has ended.';
    $('#cue').remove();
    $('#instead').remove();
    if (site) {
      const link = Object.assign(document.createElement('a'), {
        href: `https://${site}`,
        textContent: `Go to ${site}`,
      });
      $('#meta').replaceChildren(link);
    }
    return;
  }

  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const untilReset = formatDuration((midnight.getTime() - now) / 1000);
  $('#lede').textContent =
    settings.dailyBudgetMin === 0
      ? `You opened ${siteName}. Social sites are fully closed during this detox.`
      : `You opened ${siteName}. Your ${settings.dailyBudgetMin} minutes of social time come back at midnight, in ${untilReset}.`;

  const dayNum = Math.min(detox.lengthDays, Math.floor((now - detox.startedAt) / DAY_MS) + 1);
  $('#meta').textContent = `Detox day ${dayNum} of ${detox.lengthDays}. It ends ${formatWhen(detox.endsAt)}.`;
}

init();
