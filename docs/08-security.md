# TimePro — Security Design

> **Implementation status** — ✅ built · 🟡 partial · ⛔ planned. This document is the target
> posture; the MVP is **not yet hardened to it**. Do not treat the current build as production-secure.
>
> - 🟡 RBAC is enforced on `team` endpoints (owner/admin gates); tenant isolation relies on application-level `organization_id` filtering.
> - ⛔ **Not yet built:** real authentication (only email dev-login — no passwords/JWT/refresh/MFA), Postgres RLS policies (none applied), at-rest encryption, audit-log writes (table exists, unused), device trust/registration, session management, rate limiting, WAF, SSO. The one-time handoff code (desktop→web) is the one security mechanism implemented as designed.

## 1. Threat Model (abbreviated)

| Actor                   | Capability                                            | Mitigations                                                    |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| External attacker       | Internet access, can scrape/probe API                 | TLS, WAF, rate limit, generic errors, MFA                      |
| Cross-tenant attacker   | Has a valid user in *another* org                     | RLS, tenant-bound JWT, tenant-scoped DB context                |
| Malicious employee      | Has valid agent + web session in their org            | RBAC, audit log, screenshot self-delete gated by settings      |
| Stolen device           | Has the agent's local DB + tokens                     | SQLCipher, OS-keyring tokens, refresh-token rotation w/ family detection, server-side revoke |
| Insider (TimePro ops) | DB access                                             | KMS-managed encryption for sensitive cols, audit access, just-in-time prod access |
| Compromised dependency  | Supply chain                                          | SLSA-3 build, dependency review, lockfile signing              |

---

## 2. RBAC Implementation

Authorization is centralized in `packages/auth/abilities.ts`. Every API handler runs:

```ts
preHandler: [authn, requireOrg, attachAbility],
handler: async (req) => {
  req.ability.throwUnlessCan('action', subject);
  ...
}
```

`subject` is the actual fetched entity (not a string), so per-row conditions (`{ user_id: req.user.id }`, `{ team_id: { in: req.user.managedTeamIds } }`) evaluate correctly.

| Capability matrix          | Owner | Admin | Manager | Employee |
| -------------------------- | ----- | ----- | ------- | -------- |
| Manage org + billing       | ✓     | —     | —       | —        |
| Invite/remove users        | ✓     | ✓     | —       | —        |
| Manage teams               | ✓     | ✓     | own     | —        |
| Manage projects            | ✓     | ✓     | own     | —        |
| View any user's data       | ✓     | ✓     | team    | self     |
| Approve timesheets         | ✓     | ✓     | team    | —        |
| View any screenshot        | ✓     | ✓     | team    | self     |
| Delete screenshots         | ✓     | ✓     | —       | self (settings-gated) |
| Configure settings         | ✓     | ✓     | scoped  | —        |
| Read audit log             | ✓     | ✓     | —       | —        |
| Export data                | ✓     | ✓     | team    | self     |

---

## 3. Audit Logging

Every state-changing API call writes to `audit_logs`. Read access is also logged for sensitive resources (screenshots, exports, settings changes).

Examples of audited actions:

| Action                       | Captured fields                                          |
| ---------------------------- | -------------------------------------------------------- |
| `user.invite`                | inviter, email, role                                     |
| `user.role_change`           | actor, target, before, after                             |
| `screenshot.view`            | viewer, screenshot_id, IP                                |
| `screenshot.delete`          | actor, screenshot_id, reason                             |
| `settings.update`            | actor, scope, key diffs                                  |
| `device.revoke`              | actor, device_id, reason                                 |
| `export.create`              | actor, type, filters                                     |
| `time_entry.manual_create`   | actor, entry, source                                     |
| `org.delete`                 | actor                                                    |

`audit_logs` is append-only — no UPDATE or DELETE allowed via app role (enforced by Postgres GRANT). A separate `audit-purger` role with explicit grants handles retention deletion.

---

## 4. Encryption

| Data                                | At rest                                          | In transit             |
| ----------------------------------- | ------------------------------------------------ | ---------------------- |
| Screenshots                         | App-layer AES-GCM (per-org DEK) + S3 SSE-KMS    | TLS 1.3 to S3, signed URLs |
| Postgres `users.mfa_secret`         | App-layer AES-GCM (per-org KEK)                  | TLS to DB              |
| Postgres `devices.public_key`       | Plaintext (public)                               | TLS                    |
| `device_tokens.token_hash`          | SHA-256 hash only — token never stored          | TLS                    |
| `users.password_hash`               | Argon2id (m=64MB, t=3, p=4)                     | TLS                    |
| Postgres backups                    | Server-side KMS                                  | TLS replication        |
| Agent local SQLite                  | SQLCipher with TPM/Secure Enclave-derived key   | n/a                    |
| Agent → API                         | n/a                                              | TLS 1.3, cert pinning  |
| Inter-service                       | n/a                                              | mTLS within mesh       |

Cipher choices follow NIST guidance: AES-256-GCM for symmetric, Ed25519 for signatures, X25519 for key agreement (future E2E features). No deprecated ciphers (DES, RC4, MD5, SHA1).

---

## 5. Screenshot Access Control

Screenshots are the most sensitive surface.

1. **View**: every signed URL issuance writes an `audit_logs` row tagged `screenshot.view`.
2. **Bulk view**: admin gallery uses CloudFront signed cookies scoped to `org/<id>/thumb/*` (thumb-only). Full images always require per-image SigV4 signing.
3. **Delete**: gated by `screenshots.allow_self_delete` setting. Locked at org scope by default for enterprise.
4. **Export**: requires owner/admin role + 2FA confirmation if MFA is enabled.
5. **Watermark (Phase 2)**: optional viewer-watermark overlay (viewer email + timestamp) baked into the served image for screenshots viewed by humans.

---

## 6. Device Trust

- Device registration produces a `(device_id, fingerprint, public_key)` row.
- Each request from an agent must carry a valid access token tied to a non-revoked `device_id` and matching `organization_id`.
- Refresh tokens are **rotating + single-use** with **family detection**: if a previously-rotated token is presented, the entire family is revoked and the device is flagged.
- Devices can be revoked from the admin UI; revocation propagates over WS within seconds and is enforced by JWT `jti` blacklist (Redis) until the JWT expires.

### 6.1 Token rotation chain

```
device_tokens row N        → family_id = F
   POST /agents/token/refresh
device_tokens row N+1      → family_id = F, replaced_by = N+1, revoked_at = now
   ...
If client presents row N again → all rows with family_id=F are revoked.
```

---

## 7. Session Management (Web)

- HttpOnly, Secure, SameSite=Lax cookies for access (`__Host-tf_at`) and refresh (`__Host-tf_rt`).
- CSRF: double-submit pattern using `X-TF-CSRF` header verified against a non-HttpOnly companion cookie; or SameSite=Lax + strict origin checks. We use both.
- Sessions can be revoked from "Active sessions" UI; revocation list maintained in Redis.
- Idle timeout: 12h; absolute timeout: 30d; configurable per org.

---

## 8. MFA

- TOTP (RFC 6238) using `otplib`, secret encrypted with org KEK.
- Recovery codes: 10 single-use, Argon2id-hashed.
- Enforced for owner/admin by default; org-level "require MFA for all" toggle.
- WebAuthn (passkeys) in Phase 2.

---

## 9. SSO (Phase 3)

- SAML 2.0 (for legacy enterprises) and OIDC (for modern IdPs: Okta, Google Workspace, Azure AD).
- JIT user provisioning + SCIM for de-provisioning.
- Per-org IdP config; domain claim verification.
- SSO-only orgs disable password login entirely.

---

## 10. Network Security

- TLS 1.3 everywhere; HSTS preload.
- Cert pinning in the desktop agent (with a backup pin) — defense against MITM on hostile networks.
- WAF in front of API: ModSecurity OWASP CRS + custom rules (block known scrapers, geo-block on per-org policy).
- Private subnets for everything but Nginx + Bastion.
- Bastion uses SSM Session Manager (no SSH keys). All operator commands logged.

---

## 11. Input & Output Hygiene

- All inputs validated with Zod schemas at the route boundary. Unknown fields rejected (no silent strip).
- Outputs use a `serialize(view)` function that whitelists fields per role — prevents accidental field leakage.
- SQL via Drizzle parameterized queries only. No raw `sql.raw(user_input)` paths.
- HTML rendering uses React (auto-escaped). Any raw HTML (e.g., email templates) sanitized through DOMPurify before send.
- Email templates avoid user-supplied URLs in clickable text; rendered URLs always include `rel="noopener noreferrer"`.

---

## 12. Secret Management

- Secrets in AWS Secrets Manager / Doppler / Vault — never in env files in the repo.
- Per-service IAM role for KMS, S3, Secrets Manager; least privilege.
- Rotation jobs: DB credentials (90d), JWT signing keys (key rotation with overlap), SES API keys (30d), KMS data keys (180d).
- Dev/staging never has prod data; restore-from-backup pipeline scrubs PII before populating non-prod.

---

## 13. Supply Chain

- pnpm with `frozen-lockfile` in CI.
- `npm audit` + Snyk on every PR; auto-PRs for low/medium, blocking for high.
- Container images: distroless base, SBOM generated at build, signed with cosign.
- GitHub Actions: pinned to commit SHAs; OIDC for cloud auth instead of long-lived keys.
- Tauri agent bundles signed and notarized; updater verifies signatures before swap.

---

## 14. Incident Response

- Runbook lives in the repo; on-call rotation in PagerDuty.
- Tiered severity (SEV1–4) with response time SLOs.
- Data breach playbook: containment, KMS key revocation, notification to affected orgs, post-mortem.
- Regular tabletop exercises (quarterly).

---

## 15. Compliance Roadmap

| Phase   | Target                  | Notes                                                    |
| ------- | ----------------------- | -------------------------------------------------------- |
| MVP     | GDPR (EU)               | DSAR endpoints, data retention controls, EU data region  |
| Phase 2 | SOC 2 Type II           | Controls + auditor                                       |
| Phase 3 | HIPAA-compatible plans  | BAA, additional encryption, audit retention 6y           |
| Phase 3 | ISO 27001               | Aligns with SOC 2 program                                |

Privacy controls visible to employees (transparency by design): per-screenshot indicator in tray, "what is captured" page, ability to view their own captured data without an admin's permission. This is a product differentiator and a regulatory shield.
