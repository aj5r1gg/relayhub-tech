#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SITE_ORIGIN="https://www.relayhub.tech"

printf '\n===== RELAYHUB SEO REGRESSION GATE =====\n'
printf 'Root: %s\n' "$ROOT"

printf '\n===== ASTRO CHECK =====\n'
npm run astro -- check

printf '\n===== PRODUCTION BUILD =====\n'
npm run build

printf '\n===== REQUIRED DISCOVERY FILES =====\n'

for file in \
  dist/robots.txt \
  dist/sitemap-index.xml
do
  if [[ -f "$file" ]]; then
    printf 'PASS exists: %s\n' "$file"
  else
    printf 'FAIL missing: %s\n' "$file"
    exit 1
  fi
done

mapfile -t SITEMAPS < <(
  find dist \
    -maxdepth 1 \
    -type f \
    -name 'sitemap-*.xml' \
    ! -name 'sitemap-index.xml' \
    | sort
)

if (( ${#SITEMAPS[@]} == 0 )); then
  echo "FAIL no generated URL sitemap found"
  exit 1
fi

printf 'PASS generated URL sitemap count: %s\n' "${#SITEMAPS[@]}"

printf '\n===== ROBOTS CONTRACT =====\n'

if grep -Fq \
  "Sitemap: ${SITE_ORIGIN}/sitemap-index.xml" \
  dist/robots.txt
then
  echo "PASS robots references canonical sitemap index"
else
  echo "FAIL robots sitemap reference"
  exit 1
fi

printf '\n===== GENERATED HTML SEO AUDIT =====\n'

python3 - <<'PY'
from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
import json
import re
import sys
import xml.etree.ElementTree as ET


ROOT = Path("dist")
SITE_ORIGIN = "https://www.relayhub.tech"

NOINDEX_PREFIXES = (
    "/admin/",
    "/access/",
    "/document-access/",
    "/document-download/",
    "/download-requested/",
)

KEY_PUBLIC_ROUTES = (
    "/",
    "/products/",
    "/hardware/",
    "/relayos/",
    "/how-it-works/",
    "/ecosystem/",
    "/compare/",
    "/compare/meshtastic/",
    "/compare/reticulum/",
    "/compare/signal/",
    "/compare/session/",
    "/compare/simplex/",
    "/compare/element/",
    "/recovery/",
    "/security/",
    "/validation/",
    "/news/",
)

FORBIDDEN_METADATA_TOKENS = (
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
)


class SeoParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)

        self.titles = []
        self._in_title = False
        self._title_parts = []

        self.h1_count = 0

        self.meta = []
        self.links = []
        self.jsonld = []

        self._jsonld_active = False
        self._jsonld_parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)

        if tag == "title":
            self._in_title = True
            self._title_parts = []

        elif tag == "h1":
            self.h1_count += 1

        elif tag == "meta":
            self.meta.append(attrs)

        elif tag == "link":
            self.links.append(attrs)

        elif (
            tag == "script"
            and attrs.get("type", "").lower()
            == "application/ld+json"
        ):
            self._jsonld_active = True
            self._jsonld_parts = []

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self.titles.append(
                "".join(self._title_parts).strip()
            )
            self._in_title = False

        elif tag == "script" and self._jsonld_active:
            self.jsonld.append(
                "".join(self._jsonld_parts).strip()
            )
            self._jsonld_active = False

    def handle_data(self, data):
        if self._in_title:
            self._title_parts.append(data)

        if self._jsonld_active:
            self._jsonld_parts.append(data)


def route_for(path: Path) -> str:
    rel = path.relative_to(ROOT)

    if rel == Path("index.html"):
        return "/"

    if rel.name == "index.html":
        route = "/" + rel.parent.as_posix().strip("/") + "/"
        return route

    return "/" + rel.as_posix()


def is_noindex_route(route: str) -> bool:
    return any(
        route == prefix
        or route.startswith(prefix)
        for prefix in NOINDEX_PREFIXES
    )


def get_meta(parser, *, name=None, prop=None):
    matches = []

    for attrs in parser.meta:
        if name is not None and attrs.get("name") == name:
            matches.append(attrs.get("content", ""))

        if prop is not None and attrs.get("property") == prop:
            matches.append(attrs.get("content", ""))

    return matches


def get_links(parser, rel):
    return [
        attrs.get("href", "")
        for attrs in parser.links
        if rel in attrs.get("rel", "").split()
    ]


errors = []
warnings = []

canonical_to_routes = {}
indexable_routes = set()

html_files = sorted(ROOT.rglob("*.html"))

if not html_files:
    errors.append("No generated HTML files found")

for path in html_files:
    route = route_for(path)
    text = path.read_text(encoding="utf-8")

    parser = SeoParser()
    parser.feed(text)

    expected_noindex = is_noindex_route(route)

    # ---------------------------------------------------------
    # TITLE
    # ---------------------------------------------------------

    if len(parser.titles) != 1:
        errors.append(
            f"{route}: expected exactly one title, "
            f"found {len(parser.titles)}"
        )
    elif not parser.titles[0].strip():
        errors.append(f"{route}: title is empty")

    # ---------------------------------------------------------
    # DESCRIPTION
    # ---------------------------------------------------------

    descriptions = get_meta(parser, name="description")

    if len(descriptions) != 1:
        errors.append(
            f"{route}: expected exactly one meta description, "
            f"found {len(descriptions)}"
        )
    elif not descriptions[0].strip():
        errors.append(f"{route}: meta description is empty")

    # ---------------------------------------------------------
    # ROBOTS
    # ---------------------------------------------------------

    robots = get_meta(parser, name="robots")

    if len(robots) != 1:
        errors.append(
            f"{route}: expected exactly one robots meta tag, "
            f"found {len(robots)}"
        )
        robots_value = ""
    else:
        robots_value = robots[0].lower()

    actual_noindex = "noindex" in robots_value

    if expected_noindex and not actual_noindex:
        errors.append(
            f"{route}: protected/transactional route is indexable"
        )

    if not expected_noindex and actual_noindex:
        errors.append(
            f"{route}: public route unexpectedly noindex"
        )

    if not actual_noindex:
        indexable_routes.add(route)

    # ---------------------------------------------------------
    # CANONICAL
    # ---------------------------------------------------------

    canonicals = get_links(parser, "canonical")

    if len(canonicals) != 1:
        errors.append(
            f"{route}: expected exactly one canonical, "
            f"found {len(canonicals)}"
        )
        canonical = ""
    else:
        canonical = canonicals[0].strip()

    if canonical:
        parsed = urlparse(canonical)

        if (
            parsed.scheme != "https"
            or parsed.netloc != "www.relayhub.tech"
        ):
            errors.append(
                f"{route}: invalid canonical host: {canonical}"
            )

        canonical_to_routes.setdefault(
            canonical,
            [],
        ).append(route)

    # ---------------------------------------------------------
    # H1
    # ---------------------------------------------------------

    if not expected_noindex:
        if parser.h1_count != 1:
            errors.append(
                f"{route}: expected exactly one H1, "
                f"found {parser.h1_count}"
            )

    # ---------------------------------------------------------
    # OPEN GRAPH
    # ---------------------------------------------------------

    if not expected_noindex:
        for prop in (
            "og:title",
            "og:description",
            "og:url",
            "og:image",
        ):
            values = get_meta(parser, prop=prop)

            if len(values) != 1:
                errors.append(
                    f"{route}: expected exactly one {prop}, "
                    f"found {len(values)}"
                )
            elif not values[0].strip():
                errors.append(
                    f"{route}: {prop} is empty"
                )

    # ---------------------------------------------------------
    # JSON-LD
    # ---------------------------------------------------------

    if not parser.jsonld:
        errors.append(
            f"{route}: no JSON-LD structured data"
        )

    for index, block in enumerate(parser.jsonld, start=1):
        if not block:
            errors.append(
                f"{route}: JSON-LD block {index} is empty"
            )
            continue

        try:
            json.loads(block)
        except json.JSONDecodeError as exc:
            errors.append(
                f"{route}: invalid JSON-LD block {index}: {exc}"
            )

    # ---------------------------------------------------------
    # FORBIDDEN SEO HOSTS
    # ---------------------------------------------------------

    seo_values = (
        parser.titles
        + descriptions
        + robots
        + canonicals
        + get_meta(parser, prop="og:url")
        + get_meta(parser, prop="og:image")
    )

    metadata_blob = "\n".join(seo_values).lower()

    for token in FORBIDDEN_METADATA_TOKENS:
        if token in metadata_blob:
            errors.append(
                f"{route}: forbidden metadata token {token!r}"
            )


# -------------------------------------------------------------
# DUPLICATE CANONICALS
# -------------------------------------------------------------

for canonical, routes in canonical_to_routes.items():
    if len(routes) > 1:
        errors.append(
            "Duplicate canonical "
            f"{canonical}: {', '.join(routes)}"
        )


# -------------------------------------------------------------
# SITEMAP ROUTES
# -------------------------------------------------------------

sitemap_urls = set()

for sitemap_path in sorted(
    ROOT.glob("sitemap-*.xml")
):
    if sitemap_path.name == "sitemap-index.xml":
        continue

    try:
        tree = ET.parse(sitemap_path)
    except ET.ParseError as exc:
        errors.append(
            f"{sitemap_path}: invalid XML: {exc}"
        )
        continue

    root = tree.getroot()

    for elem in root.iter():
        if elem.tag.endswith("loc") and elem.text:
            url = elem.text.strip()

            if not url.startswith(SITE_ORIGIN):
                errors.append(
                    f"{sitemap_path}: foreign sitemap URL {url}"
                )
                continue

            parsed = urlparse(url)
            route = parsed.path or "/"

            sitemap_urls.add(route)


for route in sorted(indexable_routes):
    if route not in sitemap_urls:
        errors.append(
            f"{route}: indexable HTML route missing from sitemap"
        )


for route in sorted(sitemap_urls):
    if is_noindex_route(route):
        errors.append(
            f"{route}: noindex route present in sitemap"
        )


# -------------------------------------------------------------
# KEY PUBLIC ROUTES
# -------------------------------------------------------------

for route in KEY_PUBLIC_ROUTES:
    if route not in sitemap_urls:
        errors.append(
            f"{route}: key public route missing from sitemap"
        )


# -------------------------------------------------------------
# OUTPUT
# -------------------------------------------------------------

print(
    f"Checked {len(html_files)} generated HTML pages"
)
print(
    f"Found {len(indexable_routes)} indexable HTML routes"
)
print(
    f"Found {len(sitemap_urls)} sitemap routes"
)

for warning in warnings:
    print(f"WARN {warning}")

if errors:
    print()
    for error in errors:
        print(f"FAIL {error}")

    print()
    print(
        f"SEO REGRESSION GATE FAILED: "
        f"{len(errors)} problem(s)"
    )
    sys.exit(1)

print()
print("PASS all generated pages satisfy SEO contract")
PY

printf '\n===== SITEMAP EXCLUSION CONTRACT =====\n'

for token in \
  '/admin/' \
  '/access/' \
  '/document-access/' \
  '/document-download/' \
  '/download-requested/'
do
  if grep -R -Fq "$token" dist/sitemap-*.xml; then
    printf 'FAIL sitemap contains excluded route: %s\n' "$token"
    exit 1
  else
    printf 'PASS sitemap excludes: %s\n' "$token"
  fi
done

printf '\n===== SOURCE ARTIFACT SCAN =====\n'

if grep -RniE \
  --include='*.astro' \
  --include='*.js' \
  --include='*.mjs' \
  'contentReference|oaicite|turn[0-9]+search[0-9]+|turn[0-9]+file[0-9]+' \
  src \
  >/tmp/relayhub-seo-artifacts.txt
then
  cat /tmp/relayhub-seo-artifacts.txt
  echo "FAIL citation/tool artefacts found"
  exit 1
else
  echo "PASS no citation/tool artefacts"
fi

printf '\n===== DIFF CHECK =====\n'
git diff --check

printf '\n==============================================\n'
printf 'PASS — RELAYHUB SEO REGRESSION GATE\n'
printf '==============================================\n'
