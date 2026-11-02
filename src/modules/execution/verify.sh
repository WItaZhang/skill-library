#!/bin/sh
set -eu
: "${DATABASE_URL:?Set DATABASE_URL to a real PostgreSQL database; missing credentials are not a passing test}"
# Run from repository root. Module lockfiles are independent by ownership.
for module in persistence identity execution; do
  npm ci --prefix "src/modules/$module"
done
npm run typecheck --prefix src/modules/persistence
npm run typecheck --prefix src/modules/execution
npm test --prefix src/modules/persistence
npm test --prefix src/modules/execution
npm run test:ui --prefix src/modules/execution
