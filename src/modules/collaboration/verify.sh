#!/bin/sh
set -eu
# Run at the repository (or assembled directory) root.
: "${DATABASE_URL:?Set DATABASE_URL to a real PostgreSQL database}"
for module in product persistence identity collaboration; do
  npm ci --prefix "src/modules/$module" --no-audit --no-fund
done
if [ ! -e src/node_modules ] && [ ! -L src/node_modules ]; then
  ln -s modules/product/node_modules src/node_modules
fi
npm run build --prefix src/modules/product
npm run typecheck --prefix src/modules/collaboration
npm test --prefix src/modules/product
npm test --prefix src/modules/broadcast
npm test --prefix src/modules/collaboration
