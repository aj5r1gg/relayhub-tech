#!/usr/bin/env bash

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

routes=(
  meshtastic
  meshcore
  lorawan
  amateur-radio
  reticulum
  sideband
  nomad-network
  cellular-ptt
  satellite
  signal
  session
  simplex
  element
  briar
  conventional-platforms
)

failed=0

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  failed=1
}

printf '\n===== RELAYHUB COMPARISON GATE =====\n'
printf 'Root: %s\n' "$ROOT"

printf '\n===== 1. SOURCE FILES =====\n'

[ -f src/pages/compare/index.astro ] \
  && pass "comparison hub source exists" \
  || fail "comparison hub source missing"

[ -f src/components/ComparisonTable.astro ] \
  && pass "ComparisonTable component exists" \
  || fail "ComparisonTable component missing"

for route in "${routes[@]}"; do
  file="src/pages/compare/${route}.astro"

  [ -f "$file" ] \
    && pass "source: $route" \
    || fail "source missing: $route"
done

printf '\n===== 2. SHARED COMPONENT =====\n'

for route in "${routes[@]}"; do
  file="src/pages/compare/${route}.astro"

  [ -f "$file" ] || continue

  grep -Fq 'import ComparisonTable' "$file" \
    && pass "component import: $route" \
    || fail "component import missing: $route"

  grep -Fq '<ComparisonTable' "$file" \
    && pass "component usage: $route" \
    || fail "component usage missing: $route"

  if grep -Fq '<table' "$file"; then
    fail "inline table remains: $route"
  else
    pass "no inline table: $route"
  fi
done

printf '\n===== 3. CITATION / TOOL ARTIFACTS =====\n'

if grep -RniE \
  'contentReference|oaicite|filecite|turn[0-9]+(search|file|view|fetch)' \
  src/pages/compare \
  src/components/ComparisonTable.astro
then
  fail "citation/tool artefact found"
else
  pass "no citation/tool artefacts"
fi

printf '\n===== 4. ASTRO CHECK =====\n'

npm run astro -- check \
  && pass "Astro check" \
  || fail "Astro check"

printf '\n===== 5. BUILD =====\n'

npm run build \
  && pass "Astro build" \
  || fail "Astro build"

printf '\n===== 6. GENERATED ROUTES =====\n'

[ -f dist/compare/index.html ] \
  && pass "/compare/" \
  || fail "/compare/ missing"

for route in "${routes[@]}"; do
  file="dist/compare/${route}/index.html"

  [ -f "$file" ] \
    && pass "/compare/${route}/" \
    || fail "/compare/${route}/ missing"
done

printf '\n===== 7. HUB LINKS =====\n'

if [ -f dist/compare/index.html ]; then
  for route in "${routes[@]}"; do
    grep -Fq "href=\"/compare/${route}\"" dist/compare/index.html \
      && pass "hub link: $route" \
      || fail "hub link missing: $route"
  done
fi

printf '\n===== 8. BACK LINKS =====\n'

for route in "${routes[@]}"; do
  file="dist/compare/${route}/index.html"

  [ -f "$file" ] || continue

  grep -Fq 'href="/compare"' "$file" \
    && pass "back-link: $route" \
    || fail "back-link missing: $route"
done

printf '\n===== 9. RENDERED TABLES =====\n'

for route in "${routes[@]}"; do
  file="dist/compare/${route}/index.html"

  [ -f "$file" ] || continue

  count="$(grep -o '<table' "$file" | wc -l)"

  [ "$count" -eq 1 ] \
    && pass "one rendered table: $route" \
    || fail "expected 1 rendered table, found $count: $route"
done

printf '\n===== 10. KEY NEW PAGE CONTENT =====\n'

declare -A heroes=(
  [signal]="Signal protects the conversation. RelayHub is building another way to carry it."
  [session]="Session decentralises the messenger. RelayHub decentralises the infrastructure."
  [simplex]="SimpleX removes the global user ID. RelayHub removes dependence on one transport."
  [element]="Element decentralises the servers. RelayHub decentralises the paths."
)

for route in signal session simplex element; do
  file="dist/compare/${route}/index.html"
  hero="${heroes[$route]}"

  if [ -f "$file" ] && grep -Fq "$hero" "$file"; then
    pass "hero: $route"
  else
    fail "hero missing: $route"
  fi
done

printf '\n===== 11. APPLICATION FAMILY =====\n'

for name in \
  "Signal" \
  "Session" \
  "SimpleX" \
  "Element" \
  "Briar" \
  "Conventional internet platforms"
do
  grep -Fq "$name" dist/compare/index.html \
    && pass "hub contains: $name" \
    || fail "hub missing: $name"
done

printf '\n===== 12. DIFF CHECK =====\n'

git diff --check \
  && pass "git diff --check" \
  || fail "git diff --check"

printf '\n===== 13. STATUS =====\n'
git status --short

printf '\n===== RESULT =====\n'

if [ "$failed" -eq 0 ]; then
  echo "PASS RelayHub comparison gate"
  exit 0
else
  echo "FAIL RelayHub comparison gate"
  exit 1
fi
