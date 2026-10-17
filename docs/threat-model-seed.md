# BaiSet threat model seed

First-pass STRIDE review. Unfinished items need more design or operational validation before release.

| Threat                 | Asset                             | Mitigation                                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Actor identity and roles          | Core transitions enforce RBAC. The future API must derive `Actor` from an authenticated session, never from request input.                                                                                                                                                               | Unfinished: authentication and identity binding                                                                                                                                                                             |
| Tampering              | Issued document contents          | Canonical NFC JSON content hash at issue; issued content is immutable through core operations.                                                                                                                                                                                           | Partial: no external document hash anchoring                                                                                                                                                                                |
| Tampering              | Audit history and issued content  | SHA-256 chain, optional HMAC-SHA256, index-derived entry IDs, per-entry `keyId`, and `verifyChain()` against the exported head/count anchor. SQLite and PostgreSQL reject audit-row UPDATE and DELETE with triggers. PostgreSQL also removes those privileges from the application role. | Partial: a database superuser can disable triggers and rewrite the chain and anchor. HMAC and independently published external anchors detect or limit undetected rewrites. Document hashes need independent anchoring too. |
| Repudiation            | Issue, void, and approval actions | Audit entries include actor, action, server-clock time, and document ID.                                                                                                                                                                                                                 | Unfinished: trusted time source and identity evidence                                                                                                                                                                       |
| Information disclosure | Seller/buyer data and tax IDs     | Errors avoid submitted personal values; the core does not log personal data.                                                                                                                                                                                                             | Unfinished: encryption, access control, backups, retention                                                                                                                                                                  |
| Denial of service      | Repository and issuance           | Input schemas bound strings/arrays; SQLite write transactions and PostgreSQL counter-row locks serialize number allocation across connections.                                                                                                                                           | Unfinished: deployment limits and recovery procedures                                                                                                                                                                       |
| Elevation of privilege | State transitions                 | RBAC checks run inside transition functions.                                                                                                                                                                                                                                             | Unfinished: authentication and tenant isolation                                                                                                                                                                             |

HMAC keys are supplied through service configuration and are not persisted by
either adapter. Protect and rotate the key outside the database. Keep database
credentials and connection strings in a secret manager or protected runtime
configuration; never commit or log them. Run PostgreSQL migrations as a schema
owner with `CREATEROLE`, then grant the restricted `baiset_app` role to a separately
provisioned login used by the service. That role cannot update or delete audit
rows. SQLite is a development persistence option, not a hardened deployment
profile.

The PostgreSQL migration grants `baiset_app` only the service's required
access: `CONNECT` on the current database and `USAGE` on the `public` schema;
`SELECT`, `INSERT`, and `UPDATE` on `documents` and `document_counters`;
`SELECT` and `INSERT` on `audit_entries`; and `SELECT` and `UPDATE` on
`audit_anchor`. It grants no `DELETE` privileges and no `UPDATE` privilege on
`audit_entries`. The role does not need access to `schema_migrations`.

Each keyed audit entry records the configured `keyId`, and the ID is included in
the canonical hash input. During rotation, retain old keys in the verifier's
external keyring for as long as historical entries must be verified; new
entries use the new key ID. The database stores neither key material nor the
keyring. A database superuser can still disable triggers and rewrite database
records, including the database anchor. HMAC prevents forging a valid rewritten
chain without the key; publishing exported anchors outside the database exposes
rollback or rewrites beyond the latest published head. Protect HMAC keys and
external anchors separately.

Issue dates use the Asia/Bangkok calendar date derived from the injected server
clock by default, with a configurable timezone for deployments. Audit and
creation timestamps remain absolute UTC instants. This makes the default Thai
business date independent of the host machine timezone.

The future API layer must derive `Actor` from an authenticated session, never
from request input. The core enforces role permissions but does not authenticate
the actor itself.
