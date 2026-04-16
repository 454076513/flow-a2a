#!/bin/bash
# Prepare a standalone plugin directory for Docker volume mount
# Creates .build/plugin/ with all deps resolved (no symlinks)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT/packages/plugin"
SHARED_DIR="$ROOT/packages/shared"
OUT="$ROOT/.build/plugin"

echo "[prepare-plugin] Building packages..."
cd "$ROOT"
pnpm -r build

echo "[prepare-plugin] Creating standalone plugin at $OUT..."
rm -rf "$OUT"
mkdir -p "$OUT/node_modules/@flow-a2a/shared"

# Copy plugin files
cp "$PLUGIN_DIR/package.json" "$OUT/"
cp "$PLUGIN_DIR/openclaw.plugin.json" "$OUT/"
cp -r "$PLUGIN_DIR/dist" "$OUT/dist"

# Copy shared into node_modules (real copy, not symlink)
cp "$SHARED_DIR/package.json" "$OUT/node_modules/@flow-a2a/shared/"
cp -r "$SHARED_DIR/dist" "$OUT/node_modules/@flow-a2a/shared/dist"

# Copy runtime deps from plugin node_modules (ws, @sinclair/typebox)
for dep in ws @sinclair; do
  src="$ROOT/node_modules/.pnpm"
  # Find the dep in pnpm store and copy
  if [ -d "$PLUGIN_DIR/node_modules/$dep" ]; then
    cp -rL "$PLUGIN_DIR/node_modules/$dep" "$OUT/node_modules/$dep"
  fi
done

# Also handle @sinclair/typebox which is under @sinclair dir
if [ -d "$PLUGIN_DIR/node_modules/@sinclair" ]; then
  mkdir -p "$OUT/node_modules/@sinclair"
  cp -rL "$PLUGIN_DIR/node_modules/@sinclair/typebox" "$OUT/node_modules/@sinclair/typebox"
fi

echo "[prepare-plugin] Done."
echo "[prepare-plugin] Contents:"
find "$OUT" -maxdepth 3 -type f -name "*.js" | head -20
echo "..."
echo "[prepare-plugin] Size: $(du -sh "$OUT" | cut -f1)"
