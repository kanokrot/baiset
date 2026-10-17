# BaiSet API threat model

Planning document for a future API layer. BaiSet currently provides a TypeScript
domain core and SQLite and PostgreSQL repository adapters; it does not contain
an HTTP API, browser client, authentication, or tenant isolation. Every API
control below is planned or open, not implemented. See the
[threat model seed](threat-model-seed.md) for the current core and repository
security model.

## Scope and assumptions

- Each self-hosted installation will serve one business; multi-tenant use is
  out of scope. This is a decided design target, not an implemented tenant
  boundary.
- The current core defines `issuer`, `approver`, `auditor`, and `admin` roles
  and checks roles for domain transitions. It receives `Actor` data from its
  caller and does not authenticate that actor.
- A future API must authenticate a principal and construct the core `Actor`
  from trusted server-side identity data. It must not accept actor identity or
  roles as authoritative request fields.
- The threat model assumes the browser and network are untrusted. Deployment
  operators, the API runtime, database administrators, and key custodians have
  separate privileges and responsibilities.
- Thai tax requirements and the legal correctness of documents are outside
  this threat model; required tax invoice fields still need verification
  against rd.go.th.

## Trust boundaries

| Boundary              | Trust assumption and security concern                                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser / client      | Untrusted. A future client may submit forged identities, altered document fields, replayed requests, or oversized payloads. Client-side role checks would not be authoritative.                                                                                                                           |
| API                   | Planned security boundary between clients and the core. Authentication, request validation, actor construction, authorization for reads, transport protection, and safe error handling are not implemented.                                                                                               |
| API / database        | The repositories perform persistence operations. PostgreSQL has a restricted `baiset_app` role and append-only audit triggers; a database superuser can disable triggers and rewrite records and the anchor. SQLite is documented as a development persistence option, not a hardened deployment profile. |
| API / key storage     | The core accepts an audit HMAC key through service configuration and adapters do not persist key material. Secure secret storage, delivery, rotation, and recovery are deployment responsibilities; no key-store integration is implemented.                                                              |
| Operator / deployment | Operators control the runtime, database deployment, migrations, backups, and configuration. A privileged operator can replace the application or database state. Independent HMAC key storage and external audit-anchor publication reduce, but do not remove, that trust.                                |

## STRIDE analysis

| Threat                 | Asset                                                                  | Planned mitigation                                                                                                                                                                                                                                                                                                                   | Status  |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Spoofing               | User identity and assigned roles                                       | Planned: hash passwords with Argon2id, require TOTP for approver/admin, use revocable server-side sessions, and derive `Actor` from the verified session, never request fields. Bootstrap the first admin through the install-time CLI, not public sign-up.                                                                          | Planned |
| Tampering              | Document requests, issued content, role assignments, and audit history | Planned: validate API inputs and call existing domain transitions. Restrict role changes to admins and record them in the audit chain. Authentication events and role-change audit records require API and audit integration that does not exist yet. External anchors remain planned.                                               | Planned |
| Repudiation            | Login, failed login, role change, issuance, approval, and void actions | Planned: record login, failed-login, and role-change events in the audit chain and bind actors to verified identities. The current chain records document actions only; trusted time and identity evidence remain open.                                                                                                              | Open    |
| Information disclosure | Seller/buyer data, tax IDs, audit history, and credentials             | Planned: authorize every endpoint per role, including document-level IDOR protection; do not put names, tax IDs, or other personal data in logs or error messages; use TLS for all traffic and encrypted backups. Auditor read access, CORS/CSRF details, and retention/backup policy remain open. API controls are not implemented. | Open    |
| Denial of service      | API availability, repository, and document issuance                    | Planned: apply request/body limits, rate limits, timeouts, concurrency bounds, monitoring, and recovery procedures at deployment. Core schemas already bound several fields and arrays; API-level and operational controls are not implemented.                                                                                      | Planned |
| Elevation of privilege | Cross-role actions and tenant data                                     | Planned: authorize every API operation from server-side identity, limit role changes to admins, and keep each installation single-tenant. The core checks transition roles but does not authenticate actors or enforce tenant isolation.                                                                                             | Planned |

## Decisions

| Decision                                                                                                                                                                   | Reason                                                                                                                                                         | Status                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| One self-hosted installation serves one business; multi-tenant use is out of scope.                                                                                        | Keeps tenant isolation outside the initial API design and avoids implying that the current data model enforces tenant boundaries.                              | decided (planned, not implemented) |
| Use server-side sessions rather than JWTs so access can be revoked immediately. Session cookies will be `HttpOnly`, `Secure`, and `SameSite`; rotate the session on login. | Server-side revocation provides prompt access removal; cookie flags and session rotation reduce browser credential exposure and session fixation risk.         | decided (planned, not implemented) |
| Hash passwords with Argon2id. Require TOTP MFA for `approver` and `admin`.                                                                                                 | Use a password hashing function designed to resist offline cracking and add a second factor to approval and administration actions.                            | decided (planned, not implemented) |
| Create the first admin with an install-time CLI command; never offer public sign-up.                                                                                       | Restricts privileged account bootstrap to the installation operator rather than an unauthenticated network endpoint.                                           | decided (planned, not implemented) |
| Allow only admins to change roles, and record each role change in the audit chain.                                                                                         | Limits privilege assignment and creates an auditable record of authorization changes. The current core has no role-management API or role-change audit action. | decided (planned, not implemented) |
| Record login, failed-login, and role-change events in the audit chain.                                                                                                     | Adds a trail for authentication and authorization events alongside document lifecycle events. The current audit chain does not record these event types.       | decided (planned, not implemented) |
| In a separate small PR, pin GitHub Actions to commit SHAs and enable Dependabot.                                                                                           | Reduces workflow supply-chain drift and automates dependency update visibility.                                                                                | decided (planned, not implemented) |

## Decisions needed

- Define read permissions for `auditor` and the other roles.
- Specify CORS and CSRF protections for the eventual browser/API deployment.
- Decide HMAC key storage and how audit and document hash anchors will be
  published independently of the database.
- Define retention, backup, and recovery policy for personal and tax document
  data.
