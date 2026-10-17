# BaiSet

Tamper-evident Thai tax documents.

BaiSet is an open-source foundation for managing Thai business documents, including quotations, purchase orders, invoices, billing notes, tax invoices, and credit/debit notes.

## Status

Early development. This repository contains a TypeScript domain core, a SQLite adapter for development, and a PostgreSQL adapter. It is not ready for production use.

## Scope

The core models documents, money, state transitions, numbering, permissions, and tax invoice field validation. It provides canonical content hashes for issued documents and a tamper-evident audit chain. The SQLite and PostgreSQL adapters implement the core repository interface.

Thai tax rules and required tax invoice fields must be verified against current guidance from the [Thai Revenue Department](https://www.rd.go.th/). BaiSet does not provide legal or accounting advice, and its validation does not establish legal compliance.

## Non-goals for this stage

- Web UI, authentication, PDF rendering, and deployment
- Legal or accounting advice
- Integrations with payment providers or Thai government services

Operational security controls and legal validation rules must be reviewed before release. See [the threat model seed](docs/threat-model-seed.md).

## Development

Requires Node.js 22 or newer and pnpm 10.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm audit
```
