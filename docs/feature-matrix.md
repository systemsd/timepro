# TimePro — Feature Matrix (Managers & Employees)

_What works today vs what's stubbed, by role. Snapshot: 2026-06-15._

Roles (RBAC in `apps/api/src/lib/access.ts`): **owner/admin** see all org users; **manager** sees their own
team (`teams.manager_user_id` → `team_members`) + self; **employee** sees only themselves.

Legend: ✅ working · 🟡 partial · 🔴 not built (stubbed/disabled).

## Manager / Admin

| Feature | Status | Notes |
| ------- | ------ | ----- |
| **My Home → team roster** | ✅ | Per-employee today/yesterday/week/month totals, last app, last screenshot. Manager = own team; admin = all. |
| **Realtime presence dots** | ✅ | Live offline/connected/tracking via websocket (`/v1/realtime/presence`); "N online" headline. |
| **Employee Timeline** | ✅ | Screenshot slots + activity % + per-slot app + day total + day nav, for any visible employee (avatar/Timeline dropdown). |
| **Reports console** | ✅ | Summary / Detailed / Weekly; filters RBAC-scoped (manager → team only); daily chart; Employees/Projects/Clients/Notes/Apps&URLs tabs. |
| **Saved reports + CSV/PDF export** | ✅ | Per-user saved configs (+ org-shared); CSV (Excel) + browser-print PDF. |
| **Weekly-limit visibility + enforcement** | ✅ | Roster shows `week / limit` (⚠ over); timer start blocked at the cap. |
| **Team page** | 🟡 | Roles, project toggles, invite/pause/archive/delete — RBAC-scoped (C1: manager = own team). **Invites don't send real email; no real auth behind them.** |
| **Projects page** | 🟡 | Member assignment works. Catalog is **OpsCore-managed (C2)** — local create/archive is being retired. Admin-only (☰ menu). |
| **Clients page** | 🟡 | Lists clients (= OpsCore business partners); project↔client mapping syncs from OpsCore (C3). Admin-only. |
| **Settings** | ✅ | Org defaults + per-user overrides (Settings engine). Admin-only (☰ menu). |
| **OpsCore directory sync** | ✅ | Team → "Sync from OpsCore" pulls employees/projects/clients (admin). Pointed at **local** OpsCore today. |
| **My Account** | 🟡 | Profile (name/org/email/role/tz) ✅; profile/security/API-token actions 🔴 (Phase 6 auth). |
| **Day / Month roster switch** | ✅ | **Calendar day-strip** on the dashboard: ‹ Month Year › + Today, a row of all days (weekday letter + number, weekend-styled, green dot on days with team activity via `/v1/roster/activity`), pick a day → roster shows that day (`/v1/roster?period=day&date=`). Over-weekly-limit badge on the name. _(Typecheck-clean; not live-run — API was down.)_ |
| **Reports shareable links** | 🔴 | Deferred (org-shared saved reports exist; public links don't). |
| **Real login (password/JWT/MFA)** | 🔴 | Dev `x-dev-*` shim + OpsCore handoff only. Phase 6. |
| **Org onboarding / multi-tenant switch** | 🔴 | Single global OpsCore org today; multi-tenant is Phase 6. |
| **Installer downloads** | 🔴 | Download page links are placeholders (Phase 7). |

## Employee

| Feature | Status | Notes |
| ------- | ------ | ----- |
| **Desktop time tracking** | ✅ | Start/stop timer; idempotent; weekly-limit 409 surfaces a clear message. |
| **Automatic screenshot capture** | ✅ | On a cadence while tracking → API → disk; native OS toast when `screenshots.notify` is on. |
| **Activity + app + URL capture** | ✅ | Idle-derived activity %, active-app intervals; URL via the browser extension (built, unverified in Chrome). |
| **My Home (personal)** | ✅ | Tracked today, this-week vs weekly limit (+ over-limit banner), screenshots, session count. |
| **Own Timeline** | ✅ | Direct link to own day timeline (screenshots + activity). |
| **Reports (self)** | ✅ | Reports console scoped to own data only. |
| **My Account** | 🟡 | Own profile ✅; edit/change-password/2FA/delete/API-token 🔴 (Phase 6). |
| **Desktop OpsCore login** | ✅ | Loopback flow (browser → OpsCore → agent). Email dev-login also available (non-prod). |
| **Desktop → web "view online" handoff** | ✅ | One-time code opens the web dashboard already signed in. |
| **Team / roster / other employees** | 🔴 (by design) | Employees have no team/roster access (RBAC). |
| **Real login (password/JWT/MFA)** | 🔴 | Phase 6. |
| **Installer download** | 🔴 | Placeholder links (Phase 7). |

## Cross-cutting "not working yet"

- **Real auth** — everyone is on the `x-dev-*` shim + OpsCore handoff; no password/JWT/MFA (Phase 6).
- **Multi-tenancy** — one shared DB but a single global OpsCore org; per-company onboarding + RLS isolation is Phase 6.
- **My Account actions** — edit profile, change password/email, 2FA/passkeys, delete account, API token: disabled placeholders (Phase 6).
- **Email** — invites and notifications don't actually send.
- **Installer pipeline, S3 storage, rollups, billing** — Phases 7–9.

See [docs/13](13-opscore-feature-roadmap.md) for the phased roadmap and [STATUS.md](STATUS.md) for the snapshot.
