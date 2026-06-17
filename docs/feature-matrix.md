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
| **Employee Timeline + calendar strip** | ✅ | Per-user day view (screenshot slots + activity % + per-slot app + day total). Date nav is a **calendar day-strip** (‹ Month Year › + Today, day cells with green activity dots + hover tooltip showing that day's `00h 00m`, via `/v1/timeline/:userId/activity`). Clicking a screenshot opens a **lightbox modal** with prev/next (← →) navigation. For any visible employee (Timeline dropdown). |
| **Reports console** | ✅ | Summary / Detailed / Weekly; filters RBAC-scoped (manager → team only); daily chart; Employees/Projects/Clients/Notes/Apps&URLs tabs. |
| **Saved reports + CSV/PDF export** | ✅ | Per-user saved configs (+ org-shared); CSV (Excel) + browser-print PDF. |
| **Weekly-limit visibility + enforcement** | ✅ | Roster "This week" cell shows `week / limit` (red when over); timer start blocked at the cap. |
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
| **Installer downloads** | 🟡 | Download page is wired to the **latest GitHub Release** (auto-resolves per-OS assets); real signed installers aren't built/published yet (Phase 7 — B9). |

## Employee

| Feature | Status | Notes |
| ------- | ------ | ----- |
| **Desktop time tracking** | ✅ | Start/stop timer; idempotent; weekly-limit 409 surfaces a clear message; the colon "beats" (digital-clock blink) while tracking. The **project picker shows only the active projects the user is assigned to** (`project_members`-scoped). |
| **Automatic screenshot capture** | ✅ | On a cadence while tracking → API → disk; native OS toast when `screenshots.notify` is on. |
| **Activity + app + URL capture** | ✅ | Idle-derived activity %, active-app intervals; URL via the browser extension (built, unverified in Chrome). |
| **Employee Dashboard** | ✅ | Company-row table: one row per org the employee tracks for (org name + role badge + last-active screenshot + today/yesterday/week/month + weekly-limit). Powered by the now self-scoped `/v1/roster`. (Replaced the old stat-cards "My Home".) |
| **Own Timeline + calendar strip** | ✅ | Own day timeline (screenshots + activity), navigated by the calendar day-strip (dots = own tracked days, hover shows `00h 00m`). Click a screenshot → lightbox with prev/next. |
| **Reports (self)** | ✅ | Reports console scoped to own data only; **Clients/Projects filter dropdowns hidden** for employees (server returns empty + UI hides them). |
| **My Account** | 🟡 | Own profile ✅; edit/change-password/2FA/delete/API-token 🔴 (Phase 6). |
| **Desktop OpsCore login** | ✅ | Loopback flow (browser → **prod** OpsCore → agent), **verified end-to-end**. (Email login removed from the desktop UI too.) |
| **Desktop → web "view online" handoff** | ✅ | One-time code opens the web dashboard already signed in. |
| **Team / roster / other employees** | 🔴 (by design) | Employees have no team/roster access (RBAC). |
| **Real login (password/JWT/MFA)** | 🔴 | Phase 6. |
| **Installer download** | 🟡 | Download page resolves the latest GitHub Release; signed installers not published yet (Phase 7). |

## Cross-cutting "not working yet"

- **Real auth** — everyone is on the `x-dev-*` shim + OpsCore handoff; no password/JWT/MFA (Phase 6).
- **Multi-tenancy** — one shared DB but a single global OpsCore org; per-company onboarding + RLS isolation is Phase 6, which is **paused** (single-tenant Systemsd is the current focus).
- **My Account actions** — edit profile, change password/email, 2FA/passkeys, delete account, API token: disabled placeholders (Phase 6).
- **Email** — invites and notifications don't actually send.
- **Installer pipeline, S3 storage, rollups, billing** — Phases 7–9.

See [docs/13](13-opscore-feature-roadmap.md) for the phased roadmap and [STATUS.md](STATUS.md) for the snapshot.
