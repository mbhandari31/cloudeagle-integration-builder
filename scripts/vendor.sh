#!/usr/bin/env sh
# Rebuilds the single-file ESM bundles in vendor/ from the pinned packages in node_modules.
# The page loads only these files (no CDN), so the CSP can stay at script-src 'self'.
# Run after `npm install` whenever a pinned version changes.
set -eu
cd "$(dirname "$0")/.."
ESBUILD="npx --yes esbuild@0.24.0"
FLAGS="--bundle --format=esm --platform=browser --minify --legal-comments=eof"
mkdir -p vendor
# @anthropic-ai/sdk 1.4.0: the package's ESM entry ("exports".default = index.mjs); the
# "browser" field swaps in its node.browser shims.
$ESBUILD node_modules/@anthropic-ai/sdk/index.mjs $FLAGS --outfile=vendor/anthropic-sdk.js
# js-yaml 4.1.0: its own ESM build.
$ESBUILD node_modules/js-yaml/dist/js-yaml.mjs $FLAGS --outfile=vendor/js-yaml.js
# sucrase 3.35.0: the ESM build ("module" field).
$ESBUILD node_modules/sucrase/dist/esm/index.js $FLAGS --outfile=vendor/sucrase.js
ls -l vendor
