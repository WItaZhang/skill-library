#!/bin/sh
set -eu
# From the repository/assembled root; all dependency sources must be present.
npm ci --prefix src/modules/product --no-audit --no-fund
npm ci --prefix src/modules/persistence --no-audit --no-fund
npm ci --prefix src/modules/identity --no-audit --no-fund
npm test --prefix src/modules/product
src/modules/product/node_modules/.bin/tsc -p src/integration/production-tsconfig.json
npm run build --prefix src/modules/product
node --test src/integration/production.test.ts
# Requires local Chrome; DATABASE_URL is required to execute, otherwise explicitly skipped.
node --test src/integration/production.browser.test.ts
