# TimePro URL Tracker (browser extension)

The missing capture client for **URL tracking** (S12 / B5). It observes the
active browser tab's domain and how long it's focused, then batches those
intervals to the API's `POST /v1/ingest/url-usage`. The ingest endpoint and the
Reports → **Apps & URLs** tab are already live; this is what populates the URL
side.

No build step — it's a plain MV3 extension. Load it unpacked.

## How it works

```
content.js (on the TimePro web app)        background.js (service worker)
  reads localStorage `tf_web_session`  ──▶   stores {org, user} session
                                             tracks active-tab domain + dwell
                                             (tabs / windows / idle events)
                                             buffers intervals in storage
                                             ⏱ alarm every 30s → flush
                                                 POST /v1/ingest/url-usage
                                                 headers: x-dev-org / x-dev-user
```

Auth reuses the **dev-shim** headers (same as the web app today). When real JWT
auth lands, swap the headers for a bearer token in `background.js`.

## Load it (Chrome / Edge)

1. Sign in to the TimePro web app (so a session exists) at `http://localhost:3000`.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   this `apps/extension` folder.
3. Open the extension popup: it should show your signed-in name. Set the **API
   base** if not `http://localhost:4001`, then **Save**.
4. Browse a few sites, then click **Send now** (or wait for the 30s alarm).
5. Verify in the app: **Reports → run a report → Apps & URLs tab** shows the
   domains you visited under **Websites**.

## Notes / limits

- `Chrome` is hard-coded as the browser label; detect per-vendor later.
- Sub-second visits are dropped; long focus sessions report incrementally.
- Tracking pauses on system idle (60s) and when no window is focused.
- The popup has an on/off toggle and a manual flush.
- For production, add the real web/API hosts to `host_permissions` +
  `content_scripts.matches`, and ship signed via the Chrome Web Store.
