# Dopamine Detox

A Chrome extension that tracks how you browse, scores your "baseline" from 0 to 100,
and starts a detox that limits social sites when the baseline drops too low.

## Install

1. Unzip this folder.
2. Open chrome://extensions and turn on Developer mode (top right).
3. Click "Load unpacked" and pick the dopamine-detox folder.
4. Pin the extension so you can see the badge.

## How it works

- Tracks active time per site, only while the window is focused and you're not idle.
  A tab playing audio keeps counting so videos aren't missed.
- Each day is scored on five signals: share of browsing on social (35%), time on
  social (25%), checking habit (20%), tab hopping (10%) and late-night scrolling (10%).
- After 2 days with 20+ minutes of browsing, it averages your last 3 active days.
  If the baseline is below 40, a 3-day detox starts: social sites get 30 minutes a day,
  then redirect to a calm blocked page until midnight.
- Ending a detox early requires typing a phrase, and pauses auto-detox for 24 hours.
- Thresholds, the site list and the allowance are editable in Settings.

The score is a behavioural heuristic. It can't measure dopamine.

## Test data

When the extension is loaded unpacked, Settings shows a "Load test data" link (or open
dev.html from the extension). Pick a made-up history and load it:

- Heavy scroller: low baseline, a detox starts automatically
- Sliding: balanced early in the week, worse each day
- On the edge: hovers near the default detox line
- Balanced: steady, no detox
- First day: an early reading, too soon to call for a detox

Tick "1 minute of social time left" to start a detox that's about to block, then open a
social site. Your real history is backed up the first time you load test data, and
"Restore my real data" puts it back. Store installs ignore all of this.

## Privacy

Everything is stored in chrome.storage.local. Only hostnames and time totals are kept,
never full URLs or page content. Data older than 30 days is deleted automatically.

## Files

- background.js: service worker for tracking, scoring, detox lifecycle and blocking
- shared.js: scoring model, settings and helpers
- popup.*: toolbar popup
- blocked.*: page shown when social time runs out
- options.*: settings page
- dev.*, dev-data.js: test data page (left out of the store package)
