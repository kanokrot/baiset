# BaiSet API threat model

Planning document for a future API layer. BaiSet currently provides a TypeScript
domain core and SQLite and PostgreSQL repository adapters; it does not contain
an HTTP API, browser client, authentication, or tenant isolation. Every API
control below is planned or open, not implemented. See the
[threat model seed](threat-model-seed.md) for the current core and repository
security model.

## Scope and assumptions

- The intended deployment is self-hosted and single-tenant. This is an
  assumption for planning, not an implemented tenant boundary.
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

| Threat                 | Asset                                                      | Planned mitigation                                                                                                                                                                                                                                                   | Status  |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Spoofing               | User identity and assigned roles                           | Authenticate users at the API; derive `Actor` only from a verified server-side session or token, never request fields. Bind sessions to an identity provider and define expiry and revocation.                                                                       | Planned |
| Tampering              | Document requests, issued content, and audit history       | Validate API inputs and call the existing domain transitions. Keep audit HMAC keys out of requests and databases. Plan independently published anchors for audit history and issued document hashes; a database superuser can otherwise rewrite records and anchors. | Planned |
| Repudiation            | Issuance, approval, and void actions                       | Bind audit actor IDs to authenticated identities and retain the existing action/time/document audit fields. Decide how trusted time and identity evidence are established and retained.                                                                              | Open    |
| Information disclosure | Seller/buyer data, tax IDs, audit history, and credentials | Plan endpoint-level authorization for each role, redacted errors and logs, and controls for transport, backups, retention, and secrets. Read access for `auditor` and other roles is not defined by an API because no API exists.                                    | Open    |
| Denial of service      | API availability, repository, and document issuance        | Enforce request/body limits, rate limits, timeouts, concurrency bounds, monitoring, and recovery procedures at deployment. Core schemas already bound several fields and arrays, but API-level limits and operational controls are not implemented.                  | Open    |
| Elevation of privilege | Cross-role actions and tenant data                         | Enforce authorization on every API operation and construct roles from trusted identity data. The core checks roles for transitions, but it does not authenticate actors or provide tenant isolation.                                                                 | Planned |

## Decisions needed

- Which authentication provider and session or token model will the API use?
- What read permissions should each role have, especially `auditor`?
- Will the deployment remain single-tenant, and what isolation is required if
  that assumption changes?
- Which controls are required for CSRF, CORS, rate limits, request sizes, and
  API error/log redaction?
- Where will HMAC keys and independently published anchors be stored, backed
  up, rotated, and recovered?
- What retention, backup, and incident-recovery policy applies to personal and
  tax document data?
