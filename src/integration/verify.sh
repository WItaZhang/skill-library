#!/bin/sh
set -eu
# Run inside the assembled release root.
for module in service runtime broadcast web; do
  npm ci --prefix "src/modules/$module" --no-audit --no-fund
done
npm test --prefix src
src/modules/web/node_modules/.bin/tsc -p src/integration/tsconfig.json
node --test src/integration/application.test.ts
(cd src/integration && ../modules/web/node_modules/.bin/vitest run --config vite.test.config.ts)
npm run build --prefix src/modules/web
