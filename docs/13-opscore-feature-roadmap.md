# TimePro × OpsCore — Consolidated Feature Roadmap

Planning document for the spec set provided after the initial MVP. **No implementation** — this
captures features, phases, shared building blocks, conflicts, and open decisions.

Status legend: ✅ built · 🟡 partial · 🔴 not built · ⏳ blocked on input.

---

## 1. The ten specs at a glance

| # | Spec | Core ask |
| - | ---- | -------- |
| S1 | Opscore connection + login | Users from OpsCore; sign in with OpsCore credentials |
| S2 | Role-aware "My Home" | Admin/manager sees a team roster instead of personal dashboard |
| S3 | Employee daily Timeline | Click an employee → their day view; switch days/months |
| S4 | Timeline nav dropdown | Hover the Timeline tab → employee list with green/grey online dots |
| S5 | Admin-only Team tab | Team tab restricted to admins |
| S6 | Projects from OpsCore (Team) | Project assignment list sourced from OpsCore |
| S7 | Per-user effective-settings overrides | Override each setting per user |
| S8 | ☰ menu | Projects · Clients · Settings · Download |
| S9 | Projects page | Manage projects (catalog from OpsCore) + project members |
| S10 | Clients page | Clients = OpsCore "business partners"; time-per-client reports |
| S11 | Settings page | The settings catalog + org defaults + per-user overrides |
| S12 | Download page | Cross-platform installers + browser extension |

(Numbered S1–S12; S1 and S5–S12 came as distinct screenshots.)

---

## 2. Shared building blocks (the real foundations)

Most specs are thin UI on top of a few cross-cutting capabilities. Build these once; many features
light up together.

| Block | Powers | Status |
| ----- | ------ | ------ |
| **B1 — OpsCore sync engine** | users (S1), projects (S6/S9), clients (S10) — one engine, three entity types | 🔴 |
| **B2 — OpsCore OIDC auth** | web + desktop login (S1); brings **real JWT/session auth** (replaces dev shim) | 🔴 |
| **B3 — Presence / heartbeat** | online dots in My Home (S2) + Timeline dropdown (S4) + "N online" headlines | 🔴 (`devices.last_seen_at` exists) |
| **B4 — Activity tracking** | activity % + strip (S3), "Activity Level" setting (S11), activity column (S2) | 🔴 (`activity_samples` table exists, unused) |
| **B5 — App & URL tracking** | last app/URL column (S2), per-slot app/URL (S3), "App & URL" setting (S11), browser extension (S12) | 🔴 (no tables) |
| **B6 — Settings engine** | Settings page (S11), Team per-user overrides (S7), agent behavior | 🔴 (`settings_scoped` exists) |
| **B7 — Reports** | time-per-client (S10), weekly-limit enforcement (S11), team totals at scale (S2) | 🔴 |
| **B8 — Rollups + scheduler** | scale-out of S2/S3 aggregation; recurring OpsCore sync (B1) | 🔴 |
| **B9 — Build/sign/host pipeline** | Download page artifacts (S12) | 🔴 (local macOS build only) |
| **B10 — Realtime (WS)** | live presence/roster updates (S2/S4) | 🔴 |

---

## 3. Phased roadmap

Ordered by dependency and value. Each phase is shippable.

### Phase 0 — Quick wins (no external blockers) — ✅ BUILT
- ✅ **S5** Team tab gated to admin/manager (C1: manager = own team); RBAC scoping helper (`lib/access.ts`).
- ✅ **S8 (shell)** ☰ menu — Projects/Clients/Settings (admin) + Download (all), role-filtered.
- ✅ **S12 (page)** Download page with OS detection + placeholder URLs.
- ✅ **S2** Role-aware My Home — admin/manager → roster (`/v1/roster`, today/yesterday/week/month + last screenshot, viewer-tz); employee → personal dashboard. *(Online dot grey until B3.)*
- ✅ **S3** Employee Timeline (`/timeline/[userId]`, `/v1/timeline/:id`) — 10-min screenshot slots + day total + day nav. *(Activity strip waits on B4.)*
- ✅ **S4** Timeline nav dropdown listing employees. *(Dots grey until B3.)*
- ✅ **S9** Projects page + project-members assignment (`/v1/projects/manage`, `/:id/members`). Catalog read-only per C2.
- ✅ **S10** Clients table + `project.client_id` + page (`/v1/clients`); interim local create.

### Phase 1 — Settings engine (B6) — ✅ BUILT
- ✅ **S11** Settings catalog registry (`lib/settings-registry.ts`, 11 settings), resolver (org default ← user override, `lib/settings.ts`), Settings page UI (catalog list + typed editors + "Individual settings" per-user toggles), API (`/v1/settings`, `/settings/user/:id`, `/settings/effective`).
- ✅ **S7** Team per-user overrides — same engine; Team "effective settings" now resolver-backed.
- ✅ Agent consumes `/v1/settings/effective` (refresh ~60s): `screenshots.per_hour` → capture interval, `screenshots.enabled` honored. (Native screenshot-notification toast is the one deferred enforcement bit.)
- 🔴 Settings gated on unbuilt features (activity, app/URL, offline time, weekly-limit) store + resolve correctly but only *act* once those features ship (flagged in the UI).

### Phase 2 — Presence (B3) — ✅ BUILT
- ✅ Agent heartbeat (`POST /v1/agent/heartbeat`, every ~45s with `is_tracking`); in-memory presence store (`lib/presence.ts`, 90s TTL, Redis-swappable).
- ✅ 3-state presence (C4: offline / connected / tracking) on `/v1/roster` + `/v1/team/members`; dots wired in My Home roster + Timeline dropdown; "N online" headline; web polls every 30s.

### Phase 3 — OpsCore integration (B1 + B2) — ✅ BUILT (web auth; desktop deferred)
> **Design change discovered during implementation:** OpsCore is **not an OIDC provider** — it's
> Auth.js v5 (NextAuth) credentials + JWT. So **B2 uses OpsCore's handoff-JWT pattern** (the same one
> it already ships for "LandingPro"), not OIDC. This is simpler and matches OpsCore's conventions.
>
> - ✅ **B2 (web)** — OpsCore mints a 60s HS256 handoff JWT (`/api/timepro/handoff`) → redirects to
>   TimePro `/auth/opscore` → `POST /v1/auth/opscore/exchange` verifies it (shared secret) → JIT-creates
>   the user + membership (role-mapped) → TimePro session. "Sign in with OpsCore" button on `/login`.
>   Desktop OpsCore login is the deferred follow-up.
> - ✅ **B1 sync engine** — OpsCore exposes Bearer-authed service routes (`/api/timepro/sync/{employees,projects,business-partners}`);
>   TimePro's `POST /v1/admin/opscore/sync` (admin) pulls + upserts users/memberships/clients/projects
>   keyed on `opscore_*_id`, mapping OpsCore roles (ADMIN→admin, *_MANAGER→manager, else employee) and
>   OpsCore's project↔business-partner link (C3). Verified: 10 employees / 18 partners / 19 projects.
>   "Sync from OpsCore" button on the Team page.
> - ⛔ **C8 break-glass — SUPERSEDED.** Decision reversed: **no local break-glass owner**. OpsCore is the only auth source; the TimePro org is **JIT-created on the first OpsCore login** (`OPSCORE_ORG_SLUG` / `OPSCORE_ORG_NAME`) and all users/projects/clients flow from the OpsCore sync. The `db:seed` script was removed. Trade-off: an OpsCore outage means no one can sign in.
> - Code: OpsCore `lib/timepro.ts` + `app/api/timepro/*`; TimePro `lib/opscore.ts`, `routes/auth.ts` (exchange), `routes/admin.ts` (sync).
> - ⚙️ **Port note:** OpsCore owns `:3001`, so the **TimePro API moved to `:4001`** (web stays `:3000`).

### Phase 4 — Capture expansion (B4 + B5) — ✅ BUILT (URL via extension deferred)
- ✅ **B4** Activity tracking — agent activity aggregator (idle-derived per-minute samples → `activity_samples`, `POST /v1/ingest/activity`); Timeline day + per-slot activity %; roster avg; the "Activity Level" setting now gates the agent. *(Keyboard/mouse event counts need low-level input hooks — a later enhancement; the active/idle ratio gives a real 0–100 score now.)*
- ✅ **B5** App tracking — agent polls active window (`active-win-pos-rs`) → `app_usage` (`POST /v1/ingest/app-usage`); Timeline per-slot app + roster last-app; the "App & URL" setting gates it.
- 🔴 **URL tracking** still needs the **browser extension** (S12 extension download) — `url_usage` table + ingest path are ready for it.

### Phase 5 — Reports & scale (B7 + B8 + B10)
- ✅ **B7** Reports (5A query API · 5B console UI · 5C saved reports + exports · **weekly-limit enforcement** at timer start + roster/My-Home visibility). **UI/feature spec:** [docs/06-reporting.md §0](06-reporting.md#0-reports-console--ui--feature-spec).
- ⏸️ **B8** Rollups + scheduler — **deferred** (scale optimization; on-the-fly compute is fine at current scale, revisit on report latency). Recurring OpsCore sync can land as a lightweight cron separately.
- ✅ **B10** Realtime presence (5E) — websocket presence channel replaces the dashboard/nav presence poll. Roster-total realtime + Redis-backed pub/sub still come with B8 scale-out.
- ⏸️ **Absence model — cut** (only needed for the optional Weekly "Include absences" toggle).

**Phase 5 is complete** for the agreed scope (B7 + B10; B8 deferred, absences cut).

### Phase 6 — Ship pipeline (B9)
- Cross-platform CI builds (mac arm64/x64, Windows, Linux), code-signing + notarization, host artifacts, wire Download URLs.

---

## 4. ⚠️ Conflicts & contradictions to resolve

These are real inconsistencies across the specs (or against earlier decisions) — they need a ruling.

> **Resolved so far:**
> - **C2 → Read-only catalogs.** Projects & Clients are OpsCore-managed; **remove Create/Archive/Delete** from the Projects (S9) and Clients (S10) pages. TimePro shows them + manages *assignments* only.
> - **C3 → OpsCore owns project↔client.** The mapping **syncs from OpsCore**; no local "assign projects to clients." The Clients empty-state copy changes accordingly.
> - **C5 → Org default + per-user override (2 levels).** No team-scope settings; the `teams` table stays unused by the settings engine. "Team setting" in the screenshot = the org default.
> - **C4 → Two shades.** Presence has **three states**: grey = offline, light-green = app open/connected (fresh heartbeat), solid-green = actively tracking (timer running). B3 must track both heartbeat and timer state.
> - **C1 → Managers manage their own team.** The Team page is accessible to **admin/owner (all employees)** and **managers (their own team only)**; **employees have no access**. This *refines* S5's "admin-only" — managers get team-scoped management, not just viewing.
> - **C6 → Viewer/org timezone.** All day/week/month boundaries and "last active" labels render in the **org/viewer timezone** ("UTC+5" note). `me/today` moves off its fixed-UTC boundary.
> - **C8 → Keep a break-glass local owner.** Even with OpsCore as the IdP, **one local owner/admin** can sign in with a TimePro password so an OpsCore outage doesn't lock everyone out. B2 keeps a password path for that single account.
> - **C9 → Self-delete admin-configurable, default OFF.** `screenshots.allow_self_delete` ships **off**; admins opt in. The Download page's "you can delete your screenshots" copy is **conditional** on that setting.
>
> Still open: **C7** only (My Account vs Settings) — see below.

### C1 — Manager access to Team (S5 vs earlier Team work)
- **Earlier:** managers could *view* the Team page (read-only); RBAC allowed owner/admin/manager.
- **S5:** "Team tab only accessible by admin users."
- **Conflict:** does **manager lose Team access entirely?** And does **owner** count as admin here (assumed yes)?
- Also: S2/S3/S4 give managers a roster + employee timelines. So a manager can see *people's activity* but not the *Team management* page. Confirm that's the intent (view activity ✅, manage team ❌ for managers).

### C2 — Read-only vs hybrid catalogs (S6/S9 Projects, S10 Clients)
- **OpsCore is authoritative** (your S1 answer) ⇒ catalogs should be **read-only** in TimePro.
- **But** the Projects screenshot shows **Create / Archive / Delete**, and the Clients screenshot shows **Create**.
- **Conflict:** can admins create/delete projects & clients **locally**, or only in OpsCore (TimePro read-only)?
- Needs **one consistent answer** for both Projects and Clients.

### C3 — Project↔Client mapping ownership (S10)
- If projects *and* clients both come from OpsCore, does **OpsCore define which project belongs to which client** (syncs automatically)?
- **Or** does TimePro assign projects to clients **locally** (the Clients empty-state says "assign projects to clients")?
- These can't both be the source of truth — pick one.

### C4 — "Online" definition (S2 dot vs S4 dot)
- **S4:** green = "online **and running tracker app**."
- **S2:** the dot + "No one online" headline implies the same, but the row also shows "Last active 2 days ago" with time totals — i.e., online is independent of whether a timer is running.
- **Conflict/clarify:** is **green = app open & connected** (heartbeat fresh), or **green = actively tracking** (timer running)? One definition, used everywhere. (Optionally two shades: connected vs tracking.)

### C5 — Settings scope levels (S7 vs S11 vs data model)
- **S7:** "override the setting values **for each user**" (org default + user override).
- **S11:** "Individual settings … used instead of the **team** setting" (calls the default a *team* setting).
- **Data model** (`settings_scoped`) supports org → team → project → user.
- **Conflict/clarify:** are there real **teams** as a scope between org and user, or is "team setting" just the **org default**? (We have a `teams` table but it's unused.) Decide: 2-level (org+user) or full hierarchy.

### C6 — Timezone basis (S2 "UTC+5", S3 day boundary)
- **Clarify:** are day/week/month boundaries and labels in the **org/viewer timezone**, the **employee's** timezone, or fixed UTC? `me/today` currently uses **UTC** day boundary. The "All times are UTC+5" note implies a configurable display tz. One rule, applied consistently across My Home, Timeline, Reports.

### C7 — "My Account" vs "Settings" (S11 + S5 role text)
- The Admin role text says "does **not** have access to owner's **My Account** page settings," implying **two** settings surfaces: org **Settings** (admin-editable) and owner-only **My Account**.
- **Clarify:** is there a separate owner-only "My Account" area distinct from the ☰ → Settings page? What lives in each?

### C8 — Source of truth for users when OpsCore is down / break-glass
- **OpsCore authoritative** + **both clients use OpsCore login** ⇒ if OpsCore is unreachable, **nobody can log in**.
- **Clarify:** keep a **break-glass local owner/admin** login? (Earlier I flagged this; still open.)

### C9 — Screenshot delete permissions (S12 text)
- Download page says employees "can also **delete** your screenshots" at My Home.
- Existing setting `screenshots.allow_self_delete` exists, default locked off; the architecture treats deletion as sensitive.
- **Conflict/clarify:** can employees self-delete screenshots by default? (Affects audit/compliance.)

---

## 5. Open questions (need your input, not contradictions)

### Settings catalog specifics (S11)
1. **Value ranges**: screenshots/hr range (0–60?); blur options (allow / always / none?); week-start (Mon/Sun/…); currency list (which symbols?).
2. **"Employee desktop application settings"** sub-category — what settings are in it?

### OpsCore specifics (S1/B1/B2)
3. OIDC discovery URL, scopes, and which **claims** carry email / name / **roles** / tenant.
4. The exact **Opscore role names** → TimePro role mapping (owner/admin/manager/employee).
5. Service-to-service auth for the directory APIs — OAuth client_credentials or API key?
6. **OpsCore entity APIs**: confirm endpoints exist for **users**, **projects**, and **business partners** (clients) — and whether they expose project↔client and user↔project relationships.
7. Org/tenant mapping: one OpsCore tenant ↔ one TimePro org? Multi-tenant?
8. Desktop redirect style — loopback (`127.0.0.1`) vs custom URI scheme.

### Timeline / My Home (S2/S3/S4)
9. **"Last active"** = last screenshot, last tracked time, or last heartbeat?
10. Timeline **slot granularity** — 10-minute slots (Scrnio convention)?
11. Manager **visibility scope** — only their team(s), or all employees? (admin/owner = all.)

### Download (S12)
12. Installer **hosting** (agent-updates bucket/CDN vs static link) and **signing timing** (ship unsigned interim or wait for certs?).
13. Browser-extension **browsers** + whether it ships with B5 (app/URL tracking).

---

## 6. How this maps onto the existing codebase

| Already built (reuse) | Spec it serves |
| --------------------- | -------------- |
| Team page (members, roles, project toggles, invite/pause/archive/delete) | S5, S6, S7 |
| `me/today` aggregation pattern | S2, S3 |
| Screenshots + `/screenshots/:id/raw` | S2, S3 |
| `time_entries` | S2, S3, S7/S11 (limits), S10 (reports) |
| `memberships` + roles + RBAC | S2, S4, S5 |
| `TopNav` (My Home / Timeline / Team / ☰ placeholders) | S2, S4, S5, S8 |
| `project_members` join | S6, S9 |
| `settings_scoped` table | S7, S11 |
| `devices.last_seen_at` column | B3 |
| `activity_samples` table (unused) | B4 |
| `client_name` text on projects (to normalize) | S10 |
| Desktop build (`tauri:build`), baked API base | S12 |

| Net-new / not started | Spec |
| --------------------- | ---- |
| `clients` table + `project.client_id` | S10 |
| `opscore_*` id columns + sync engine | S1, S6, S9, S10 |
| OIDC client + callback + JWT sessions | S1 |
| Heartbeat endpoint + presence | S2, S4 |
| `app_usage` / `url_usage` tables + capture + extension | S2, S3, S5(app/url setting), S12 |
| Settings API + resolver | S7, S11 |
| Reports engine | S10, S11(limits) |
| CI build/sign/host pipeline | S12 |

---

## 7. Recommended first build order (when you greenlight)

1. **Phase 0 quick wins** (S5, ☰ shell, My Home roster, Timeline, Projects/Clients pages) — high visible progress, no blockers.
2. **B6 Settings engine** (S11 + S7) — keystone; unblocks the most.
3. **B3 Presence** — lights up dots across S2/S4.
4. **B1+B2 OpsCore** — the integration backbone (auth + sync).
5. **B4+B5 Capture** (activity, app/URL, extension).
6. **B7+B8 Reports/rollups**, then **B9 ship pipeline**, **B10 realtime**.

Resolve **C1–C9** before the phases they touch; the most urgent are **C2/C3** (OpsCore catalog authority — gates S6/S9/S10) and **C5** (settings scope — gates S7/S11).
