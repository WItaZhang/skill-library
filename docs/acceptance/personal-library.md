# Personal library acceptance

Local mode uses a persistent, password-authenticated PostgreSQL cluster, a genuine local-device identity, and a loopback-only HTTP host. It does not use the test OAuth provider or demo SQLite adapters. Source folders are explicitly configured outside the repository.

## Checks

- Integration TypeScript check; identity TypeScript check; product TypeScript check and Vite build.
- Local integration: 10 passing tests, including real PostgreSQL, HTTP, and Chrome. Repeated with Node 24.22.2.
- Identity regression: 15 passing tests.
- PostgreSQL regression: 9 passing tests, including populated migration upgrade through 003.
- Product regression: 21 passing tests.
- Production/operations/process integration: 8 passing tests.
- Operations unit tests: 5 passing tests.

Commands run from the repository root, with `DATABASE_URL` pointing at the disposable test database:

```sh
src/modules/product/node_modules/.bin/tsc -p src/integration/production-tsconfig.json
npm run typecheck --prefix src/modules/identity
npm run build --prefix src/modules/product
node --test src/modules/local/local.test.ts
npm test --prefix src/modules/identity
npm test --prefix src/modules/persistence
npm test --prefix src/modules/product
node --test src/integration/production.test.ts src/integration/operations.test.ts src/integration/production-process.test.ts
npm test --prefix src/modules/operations
```

The local suite exercises complete package import, idempotent concurrent retries, disallowed folders, source preservation until explicit writeback, backups and permission preservation, file additions/removals, external edit detection, recovery into a stale draft, authentication/CSRF/Host/Origin checks, server restart, interrupted directory recovery, and a full Chrome import → edit → publish → writeback flow. Its files and users are synthetic.

## First personal instance

The independent personal database contains one local user, six skills, six initial versions and six source connections. All twelve source files were imported. A real Chrome session verified account access, catalog contents, directory state and reload persistence without editing personal source files. Personal content, credentials, screenshots and database dumps remain outside the public repository.

A fresh personal database dump was restored into a separately created database. All 31 table/sequence fingerprints matched; the temporary restore database was then removed, and the original personal database and private dump were retained.

## Boundaries

The configured direct personal skill folders are included; bundled system/plugin skills and nested synced libraries are not automatically imported. Binary packages are rejected, and script editing remains subject to the existing platform authorization. No real Agent execution is enabled in local mode. Local HTTP is protected for loopback use and must not be exposed through a proxy. Filesystem writes and PostgreSQL commits are recoverable but are not a distributed atomic transaction; originals and backups are retained.
