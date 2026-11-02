#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
: "${DATABASE_URL:?Set real PostgreSQL DATABASE_URL; no skipped database acceptance}"
: "${DRILL_ADMIN_URL:?Set a test-cluster admin URL permitted to create temporary databases}"
sh src/deployment/install.sh
node -e 'if(Number(process.versions.node.split(".")[0])<24) process.exit(1)'
# Every phase 4–6 module is required. Missing code or credentials for local dependencies fails CI.
for module in service runtime broadcast web persistence identity product execution operations; do
  npm run typecheck --prefix "src/modules/$module"
done
src/modules/product/node_modules/.bin/tsc -p src/integration/production-tsconfig.json
src/modules/web/node_modules/.bin/tsc -p src/integration/tsconfig.json
npm test --prefix src
npm test --prefix src/modules/persistence
npm test --prefix src/modules/identity
npm test --prefix src/modules/product
npm test --prefix src/modules/execution
npm run test:ui --prefix src/modules/execution
npm test --prefix src/modules/operations
npm run build --prefix src/modules/product
npm run build --prefix src/modules/web
node --test src/integration/application.test.ts
(cd src/integration && ../modules/product/node_modules/.bin/vitest run --config vite.test.config.ts)
node --test src/integration/production.test.ts src/integration/operations.test.ts
# Browser executable selection is explicit in CI, or the harness's local Chrome default.
node --test src/integration/production.browser.test.ts
npm test --prefix src/modules/collaboration
node src/modules/operations/backup-drill.ts
