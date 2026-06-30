# TimePro — Feature Matrix (Managers & Employees)

_What works today vs what's stubbed, by role. Snapshot: 2026-06-17._

Roles (RBAC in `apps/api/src/lib/access.ts`): **owner/admin** see all org users; **manager** sees their own
team (`teams.manager_user_id` → `team_members`) + self; **employee** sees only themselves.

Legend: ✅ working · 🟡 partial · 🔴 not built (stubbed/disabled).

## Manager / Admin

| Feature | Status | Notes |
| ------- | ------ | ----- |
| **My Home → team roster** | ✅ | 4-column overview (today/yesterday/week/month) per visible employee + last app + last screenshot. Manager = own team; admin = all. |
| **Realtime presence dots** | ✅ | Live offline/connected/tracking via websocket (`/v1/realtime/presence`); "N online" headline. |
| **Employee Timeline (Hubstaff-style)** | ✅ | Per-user day view: month strip with weekday labels (weekends red) + per-day **activity bars** (`/v1/timeline/:userId/activity`) + yellow selected day; **summary card** (date · day total · Week/Month/Activity) with an **Apps/URLs** usage panel (`/v1/timeline/:userId/apps-urls`) + day stepper + **average-activity donut**; **24h ruler** with green **run/stop bars** from real tracked intervals (`intervals[]`); **activities** (one block per time entry: time range · activity dot · project · description) each with **its screenshots grouped underneath** (per-shot app label + dot; thumbnail trash **hover-reveals** → one-click delete + "Screenshot deleted" toast; click → **lightbox** prev/next). Clicking a **Task** in the summary panel jumps to its activity. For any visible employee (Timeline dropdown). |
| **Edit Timeline activities** | ✅ | Click an activity → "Edit Time" modal: change **project/description**, **trim** start/end, **split**, or **delete**. `routes/time-entries.ts` (`PATCH`/`POST :id/split`/`DELETE`/`GET :id/history`); every change audited to `audit_logs`. RBAC: admin/manager any, employee self gated by **`time.allow_self_edit`** (default on). |
| **Reports console** | ✅ | Hubstaff-style filter bar (2×4 preset-link grid, stacked filter fields, report-type **text links**, group-by **chip field**); Summary / Detailed / Weekly; filters RBAC-scoped (manager → team only); daily chart; Employees/Projects/Clients/Notes/Apps&URLs tabs. (Deferred: Money/$, date·note grouping, share links.) |
| **Saved reports + CSV/PDF export** | ✅ | Per-user saved configs (+ org-shared); CSV (Excel) + browser-print PDF. |
| **Weekly-limit visibility + enforcement** | ✅ | Roster "This week" cell shows `week / limit` (red when over); timer start blocked at the cap. |
| **Reporting self-heal (abandoned timers)** | ✅ | A timer left open across sleep/crash was counted to `now`, inflating totals (one entry hit 107h). A server sweep (`lib/timer-sweep.ts`; every 10 min, `asPlatform`) clamps such entries to the user's last real activity (`source=system`, audited). Self-healing for all users; verified in prod (a user's month went 138h → 19h). |
| **Team page** | 🟡 | Roles, project toggles, invite/pause/archive/delete — RBAC-scoped (C1: manager = own team). **Invites don't send real email; no real auth behind them.** |
| **Projects page** | 🟡 | Member assignment works. Catalog is **OpsCore-managed (C2)** — local create/archive is being retired. Admin-only (☰ menu). |
| **Clients page** | 🟡 | Lists clients (= OpsCore business partners); project↔client mapping syncs from OpsCore (C3). Admin-only. |
| **Settings** | ✅ | Org defaults + per-user overrides (Settings engine). Admin-only (☰ menu). |
| **OpsCore directory sync** | ✅ | Team → "Sync from OpsCore" pulls employees/projects/clients (admin). **Members no longer in the OpsCore response are auto-disabled** (membership → `suspended`); members that reappear are re-activated. Returns a `disabled` count. Local/owner accounts never auto-disabled. |
| **OpsCore sign-in** | ✅ | Wired to **production** OpsCore (`https://opscore.systemsd.co`) and verified end-to-end. Login is OpsCore-only (no email/password). |
| **My Account** | 🟡 | Profile (name/org/email/role/tz) ✅; profile/security/API-token actions 🔴 (Phase 6 auth). |
| **Reports shareable links** | 🔴 | Deferred (org-shared saved reports exist; public links don't). |
| **Real login (password/JWT/MFA)** | 🔴 | Dev `x-dev-*` shim + OpsCore handoff only. Phase 6. |
| **Org onboarding / multi-tenant switch** | 🔴 | Single global OpsCore org today; multi-tenant is Phase 6. |
| **Installer downloads + auto-update** | ✅ | Download page resolves the **latest Release of the separate PUBLIC `timepro-downloads` repo**; CI (`desktop-release.yml`, mac + Windows) publishes there via the `RELEASES_REPO_TOKEN` PAT on each version bump. **In-app auto-updater** live (v0.1.5+; polls `latest.json`). Current shipped **v0.1.12**. Still **unsigned** (each mac update revokes Screen Recording — Phase 7 sign/notarize pending); Linux leg disabled. |

## Employee

| Feature | Status | Notes |
| ------- | ------ | ----- |
| **Desktop time tracking** | ✅ | Start/stop timer; idempotent; weekly-limit 409 surfaces a clear message; the colon "beats" (digital-clock blink) while tracking. The **project picker shows only the active projects the user is assigned to** (`project_members`-scoped). |
| **Idle auto-pause + auto-resume** | ✅ | After `tracking.auto_pause_minutes` of input idle the timer pauses (back-dated so idle isn't billed; UI reads "Paused — idle"); it **auto-resumes the instant input returns** (v0.1.12) — a fresh entry with the same project/note, no manual play. Sleep/suspend still resumes manually. |
| **Automatic screenshot capture** | ✅ | On a cadence while tracking → API → disk (capture+upload off the loop so a slow upload can't stall cadence); native OS toast when `screenshots.notify` is on. |
| **Delete screenshots** | ✅ | Trash **hover-reveals** on a Timeline thumbnail → one-click `DELETE /v1/screenshots/:id` (row + file) → "Screenshot deleted" toast. Admins/managers anytime (within visible set); employees on their own only when `screenshots.allow_self_delete` is on (default off — C9). |
| **Screenshot retention** | ✅ | Org-wide `screenshots.retention_days` (1/3/6/12 months or Forever; default 3 months). Auto-prunes old screenshots (rows + files) via an in-process sweep (`lib/retention.ts`; 12h cadence, no scheduler yet); `POST /v1/admin/screenshots/prune` for on-demand. Reports unaffected. |
| **Activity + app + URL capture** | ✅ | Idle-derived activity %, active-app intervals; URL via the browser extension (built, unverified in Chrome). |
| **Employee Dashboard** | ✅ | Company-row table: one row per org the employee tracks for (org name + role badge + last-active screenshot + today/yesterday/week/month + weekly-limit). Powered by the now self-scoped `/v1/roster`. (Replaced the old stat-cards "My Home".) |
| **Own Timeline (Hubstaff-style)** | ✅ | Own day timeline (screenshots + activity), navigated by the month strip with per-day activity bars; summary card + Apps/URLs panel + average-activity donut + 24h run/stop ruler. Click a thumbnail → lightbox with prev/next. |
| **Reports (self)** | ✅ | Reports console scoped to own data only; **Clients/Projects filter dropdowns hidden** for employees (server returns empty + UI hides them). |
| **My Account** | 🟡 | Own profile ✅; edit/change-password/2FA/delete/API-token 🔴 (Phase 6). |
| **Desktop OpsCore login** | ✅ | Loopback flow (browser → **prod** OpsCore → agent), **verified end-to-end**. (Email login removed from the desktop UI too.) **Session persists** across restarts (`session.json` in the app data dir; v0.1.12) — no sign-in on every launch. |
| **Desktop → web "view online" handoff** | ✅ | One-time code opens the web dashboard already signed in. |
| **Team / roster / other employees** | 🔴 (by design) | Employees have no team/roster access (RBAC). |
| **Real login (password/JWT/MFA)** | 🔴 | Phase 6. |
| **Installer download** | 🟡 | Download page resolves the latest Release from the public `timepro-downloads` repo; signed installers not published yet (Phase 7). |

## Cross-cutting "not working yet"

- **Real auth** — everyone is on the `x-dev-*` shim + OpsCore handoff; no password/JWT/MFA (Phase 6).
- **Multi-tenancy** — one shared DB but a single global OpsCore org; per-company onboarding + RLS isolation is Phase 6, which is **paused** (single-tenant Systemsd is the current focus).
- **My Account actions** — edit profile, change password/email, 2FA/passkeys, delete account, API token: disabled placeholders (Phase 6).
- **Email** — invites and notifications don't actually send.
- **Installer pipeline, S3 storage, rollups, billing** — Phases 7–9.

See [docs/13](13-opscore-feature-roadmap.md) for the phased roadmap and [STATUS.md](STATUS.md) for the snapshot.
