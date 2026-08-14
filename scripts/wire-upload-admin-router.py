#!/usr/bin/env python3

from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
ROUTER = ROOT / "worker/src/router.js"

BACKUP = (
    ROOT
    / ".refactor-backups"
    / f"upload-router-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
)

IMPORT_BLOCK = '''import {
  handleUploadAdminRequest,
} from "./upload/admin-routes.js";
'''

ANCHOR_IMPORT = '''import {
  handleCdasAccessInvitationMetadata,
} from "./cdas/invitation-metadata.js";
'''

ROUTE_BLOCK = '''  /*
   * CDAS controlled upload administration.
   *
   * The upload subsystem owns authentication, feature switches,
   * method validation and gate-specific routing.
   */
  if (pathname.startsWith("/api/admin/uploads")) {
    return handleUploadAdminRequest(request, env);
  }

'''

ROUTE_ANCHOR = '''  /*
   * CDAS admin routes.
   */
'''


def fail(message):
    print(f"FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def run(command):
    print("$", " ".join(command))

    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
    )

    if result.stdout:
        print(result.stdout, end="")

    if result.returncode != 0:
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")

        raise RuntimeError(
            f"command failed: {' '.join(command)}"
        )


if not ROUTER.exists():
    fail("worker/src/router.js does not exist")

text = ROUTER.read_text(encoding="utf-8")

if 'from "./upload/admin-routes.js"' in text:
    fail("upload admin dispatcher is already imported")

if 'pathname.startsWith("/api/admin/uploads")' in text:
    fail("upload admin route is already wired")

if text.count(ANCHOR_IMPORT) != 1:
    fail("expected invitation-metadata import anchor exactly once")

if text.count(ROUTE_ANCHOR) != 1:
    fail("expected CDAS admin route anchor exactly once")

BACKUP.mkdir(parents=True, exist_ok=False)

saved = BACKUP / ROUTER.relative_to(ROOT)
saved.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(ROUTER, saved)

print(f"Backup created: {BACKUP}")

try:
    text = text.replace(
        ANCHOR_IMPORT,
        ANCHOR_IMPORT + "\n" + IMPORT_BLOCK,
        1,
    )

    text = text.replace(
        ROUTE_ANCHOR,
        ROUTE_BLOCK + ROUTE_ANCHOR,
        1,
    )

    ROUTER.write_text(text, encoding="utf-8")

    run([
        "node",
        "--check",
        "worker/src/router.js",
    ])

    run([
        "node",
        "--check",
        "worker/index.js",
    ])

    run([
        "git",
        "diff",
        "--check",
    ])

    updated = ROUTER.read_text(encoding="utf-8")

    if updated.count(
        'from "./upload/admin-routes.js"'
    ) != 1:
        raise RuntimeError(
            "upload admin import postcondition failed"
        )

    if updated.count(
        'pathname.startsWith("/api/admin/uploads")'
    ) != 1:
        raise RuntimeError(
            "upload admin route postcondition failed"
        )

    if (
        "return handleUploadAdminRequest(request, env);"
        not in updated
    ):
        raise RuntimeError(
            "upload admin dispatcher call postcondition failed"
        )

    route_position = updated.index(
        'pathname.startsWith("/api/admin/uploads")'
    )

    assets_fallback_position = updated.rfind(
        "return env.ASSETS.fetch(request);"
    )

    if assets_fallback_position < 0:
        raise RuntimeError(
            "static asset fallback could not be located"
        )

    if route_position > assets_fallback_position:
        raise RuntimeError(
            "upload route was inserted after static asset fallback"
        )

except Exception as exc:
    print(
        f"Router patch failed: {exc}",
        file=sys.stderr,
    )

    print(
        "Restoring router backup.",
        file=sys.stderr,
    )

    shutil.copy2(saved, ROUTER)

    raise SystemExit(1)


print()
print("PASS — upload admin dispatcher imported by live router")
print("PASS — /api/admin/uploads routed before asset fallback")
print("PASS — router syntax")
print("PASS — Worker entrypoint syntax")
print("PASS — router structural postconditions")
print("PASS — git diff --check")
print()
print(
    "NOTE — runtime Worker loading is validated with Wrangler, "
    "not plain Node, because the Worker dependency graph uses "
    "Cloudflare-specific module specifiers."
)
print()
print(f"Backup retained: {BACKUP}")
