#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
for module in service runtime broadcast web persistence identity product execution operations collaboration; do
  test -f "src/modules/$module/package-lock.json" || { echo "Missing release module/lockfile: $module" >&2; exit 1; }
  npm ci --prefix "src/modules/$module" --no-audit --no-fund
done
if [ ! -e src/node_modules ] && [ ! -L src/node_modules ]; then ln -s modules/product/node_modules src/node_modules; fi
