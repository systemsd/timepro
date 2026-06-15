// TimePro URL Tracker — MV3 service worker.
//
// Tracks the active tab's domain and how long it's focused, then batches the
// intervals to the API's `/v1/ingest/url-usage` endpoint (the same shape the
// desktop agent uses for app-usage). Auth reuses the dev-shim headers: the
// content script on the TimePro web app forwards the logged-in session here.
//
// State lives in chrome.storage.local so it survives the service worker being
// torn down (MV3 SWs are ephemeral). A periodic alarm flushes the buffer.

const FLUSH_ALARM = 'tp-url-flush';
const FLUSH_SECONDS = 30;
const MIN_INTERVAL_MS = 1000; // ignore sub-second blips
const IDLE_THRESHOLD_SECONDS = 60;
const DEFAULT_API_BASE = 'http://localhost:4001';

async function getState() {
  const d = await chrome.storage.local.get([
    'session',
    'apiBase',
    'enabled',
    'current',
    'buffer',
  ]);
  return {
    session: d.session ?? null,
    apiBase: d.apiBase ?? DEFAULT_API_BASE,
    enabled: d.enabled !== false, // default on
    current: d.current ?? null, // { domain, startedAt }
    buffer: Array.isArray(d.buffer) ? d.buffer : [],
  };
}

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

async function closeCurrent(nowMs) {
  const s = await getState();
  if (s.current && s.current.domain && nowMs - s.current.startedAt >= MIN_INTERVAL_MS) {
    s.buffer.push({
      browser: 'Chrome',
      domain: s.current.domain,
      started_at: new Date(s.current.startedAt).toISOString(),
      ended_at: new Date(nowMs).toISOString(),
    });
    await chrome.storage.local.set({ buffer: s.buffer.slice(-2000) });
  }
  await chrome.storage.local.set({ current: null });
}

async function startInterval(domain, nowMs) {
  await chrome.storage.local.set({ current: domain ? { domain, startedAt: nowMs } : null });
}

async function switchTo(url) {
  const now = Date.now();
  await closeCurrent(now);
  const s = await getState();
  if (!s.enabled || !s.session) return;
  await startInterval(domainOf(url), now);
}

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? null;
  } catch {
    return null;
  }
}

chrome.tabs.onActivated.addListener(async () => {
  await switchTo(await activeTabUrl());
});

chrome.tabs.onUpdated.addListener(async (_tabId, info, tab) => {
  if (info.url && tab.active) await switchTo(info.url);
});

chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) await closeCurrent(Date.now());
  else await switchTo(await activeTabUrl());
});

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'active') await switchTo(await activeTabUrl());
  else await closeCurrent(Date.now());
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'session' && msg.session?.organization_id && msg.session?.user_id) {
    chrome.storage.local.set({
      session: {
        organization_id: msg.session.organization_id,
        user_id: msg.session.user_id,
        display_name: msg.session.display_name ?? null,
      },
    });
    return;
  }
  if (msg?.type === 'signout') {
    chrome.storage.local.set({ session: null, current: null });
    return;
  }
  if (msg?.type === 'flush') {
    flush().then((n) => sendResponse({ ok: true, sent: n }));
    return true; // async response
  }
});

chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_SECONDS / 60 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === FLUSH_ALARM) flush();
});

// Roll the open interval into the buffer (so long focus sessions report
// incrementally), then POST a batch. Keeps the buffer on failure for retry.
async function flush() {
  const now = Date.now();
  const s = await getState();
  if (s.current && s.current.domain && now - s.current.startedAt >= MIN_INTERVAL_MS) {
    s.buffer.push({
      browser: 'Chrome',
      domain: s.current.domain,
      started_at: new Date(s.current.startedAt).toISOString(),
      ended_at: new Date(now).toISOString(),
    });
    await chrome.storage.local.set({
      buffer: s.buffer.slice(-2000),
      current: { domain: s.current.domain, startedAt: now },
    });
  }

  const cur = await getState();
  if (!cur.session || cur.buffer.length === 0) return 0;
  const batch = cur.buffer.slice(0, 500);
  try {
    const res = await fetch(`${cur.apiBase.replace(/\/$/, '')}/v1/ingest/url-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dev-org': cur.session.organization_id,
        'x-dev-user': cur.session.user_id,
      },
      body: JSON.stringify({ events: batch }),
    });
    if (res.ok) {
      const after = await getState();
      await chrome.storage.local.set({ buffer: after.buffer.slice(batch.length) });
      return batch.length;
    }
  } catch {
    /* keep buffer, retry on next alarm */
  }
  return 0;
}
