#!/usr/bin/env python3

from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime


ROOT = Path(__file__).resolve().parents[1]

ADMIN_ROUTES = ROOT / "worker/src/upload/admin-routes.js"
POLICY = ROOT / "worker/src/upload/admin/policy.js"
U3Q = ROOT / "worker/src/upload/admin/gates/cdas-access-request-review.js"
ACTIONS = ROOT / "worker/src/upload/admin/actions.js"

BACKUP = (
    ROOT
    / ".refactor-backups"
    / f"cdas-actions-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
)


DRAFT_BLOCK = '''const VALID_CDAS_DRAFT_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_activation_prep",
]);
'''

LISTING_BLOCK = '''const VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS = new Set([
  "list_only",
  "enable_requestability",
  "disable_requestability",
  "unlist",
]);
'''

ACCESS_BLOCK = '''const VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_licence_prep",
]);
'''

ACTIONS_CONTENT = '''// Canonical CDAS admin workflow action definitions.
//
// Shared by route validation and policy reporting so that permitted action
// names have a single source of truth.

export const VALID_CDAS_DRAFT_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_activation_prep",
]);

export const VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS = new Set([
  "list_only",
  "enable_requestability",
  "disable_requestability",
  "unlist",
]);

export const VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_licence_prep",
]);
'''


def abort(message):
    print(f"FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def backup_file(path):
    if not path.exists():
        return

    destination = BACKUP / path.relative_to(ROOT)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, destination)


def import_statements(text):
    """
    Return complete top-level ESM import statements, including multiline ones.
    """

    pattern = re.compile(
        r'(?ms)^[ \t]*import\b.*?;[ \t]*(?:\r?\n)?'
    )

    return list(pattern.finditer(text))


def add_import(text, statement):
    """
    Insert a complete import statement after the final existing import.

    This is multiline-import safe.
    """

    if statement.strip() in text:
        return text

    matches = import_statements(text)

    if not matches:
        return statement.rstrip() + "\n\n" + text

    insert_at = matches[-1].end()

    return (
        text[:insert_at].rstrip()
        + "\n"
        + statement.rstrip()
        + "\n\n"
        + text[insert_at:].lstrip("\n")
    )


def run_check(command):
    print("$", " ".join(command))

    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
    )

    if result.returncode != 0:
        if result.stdout:
            print(result.stdout)

        if result.stderr:
            print(result.stderr, file=sys.stderr)

        raise RuntimeError(
            f"validation failed: {' '.join(command)}"
        )


for required in [
    ADMIN_ROUTES,
    POLICY,
    U3Q,
]:
    if not required.exists():
        abort(
            f"missing required file: {required.relative_to(ROOT)}"
        )


if ACTIONS.exists():
    abort(
        "worker/src/upload/admin/actions.js already exists"
    )


admin_text = ADMIN_ROUTES.read_text(encoding="utf-8")
policy_text = POLICY.read_text(encoding="utf-8")
u3q_text = U3Q.read_text(encoding="utf-8")


for label, block, text in [
    (
        "draft review actions",
        DRAFT_BLOCK,
        admin_text,
    ),
    (
        "listing/requestability actions",
        LISTING_BLOCK,
        admin_text,
    ),
    (
        "access request review actions",
        ACCESS_BLOCK,
        u3q_text,
    ),
]:
    count = text.count(block)

    if count != 1:
        abort(
            f"expected exactly one {label} block, found {count}"
        )


for symbol in [
    "VALID_CDAS_DRAFT_REVIEW_ACTIONS",
    "VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS",
    "VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS",
]:
    if symbol not in policy_text:
        abort(
            f"policy.js does not reference expected symbol {symbol}"
        )


BACKUP.mkdir(
    parents=True,
    exist_ok=False,
)

for path in [
    ADMIN_ROUTES,
    POLICY,
    U3Q,
]:
    backup_file(path)

print(f"Backup created: {BACKUP}")


try:
    # ------------------------------------------------------------------
    # Remove local action-set definitions.
    # ------------------------------------------------------------------

    admin_text = admin_text.replace(
        DRAFT_BLOCK,
        "",
        1,
    )

    admin_text = admin_text.replace(
        LISTING_BLOCK,
        "",
        1,
    )

    u3q_text = u3q_text.replace(
        ACCESS_BLOCK,
        "",
        1,
    )

    # ------------------------------------------------------------------
    # Add canonical imports.
    # ------------------------------------------------------------------

    admin_text = add_import(
        admin_text,
        '''import {
  VALID_CDAS_DRAFT_REVIEW_ACTIONS,
  VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS,
} from "./admin/actions.js";'''
    )

    policy_text = add_import(
        policy_text,
        '''import {
  VALID_CDAS_DRAFT_REVIEW_ACTIONS,
  VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS,
  VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS,
} from "./actions.js";'''
    )

    u3q_text = add_import(
        u3q_text,
        '''import {
  VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS,
} from "../actions.js";'''
    )

    # ------------------------------------------------------------------
    # Write files.
    # ------------------------------------------------------------------

    ACTIONS.write_text(
        ACTIONS_CONTENT,
        encoding="utf-8",
    )

    ADMIN_ROUTES.write_text(
        admin_text,
        encoding="utf-8",
    )

    POLICY.write_text(
        policy_text,
        encoding="utf-8",
    )

    U3Q.write_text(
        u3q_text,
        encoding="utf-8",
    )

    # ------------------------------------------------------------------
    # Syntax validation.
    # ------------------------------------------------------------------

    checks = [
        [
            "node",
            "--check",
            "worker/src/upload/admin/actions.js",
        ],
        [
            "node",
            "--check",
            "worker/src/upload/admin/policy.js",
        ],
        [
            "node",
            "--check",
            "worker/src/upload/admin/common.js",
        ],
        [
            "node",
            "--check",
            "worker/src/upload/admin/gates/cdas-access-request-review.js",
        ],
        [
            "node",
            "--check",
            "worker/src/upload/admin-routes.js",
        ],
        [
            "git",
            "diff",
            "--check",
        ],
    ]

    for command in checks:
        run_check(command)

    # ------------------------------------------------------------------
    # Runtime import validation.
    # ------------------------------------------------------------------

    runtime_checks = [
        (
            "actions",
            "./worker/src/upload/admin/actions.js",
        ),
        (
            "policy",
            "./worker/src/upload/admin/policy.js",
        ),
        (
            "common",
            "./worker/src/upload/admin/common.js",
        ),
        (
            "U3-Q",
            "./worker/src/upload/admin/gates/cdas-access-request-review.js",
        ),
        (
            "admin-routes",
            "./worker/src/upload/admin-routes.js",
        ),
    ]

    for label, module in runtime_checks:
        run_check(
            [
                "node",
                "-e",
                (
                    f'import("{module}")'
                    f'.then(() => console.log("PASS {label} import"))'
                    '.catch(e => { '
                    'console.error(e); '
                    'process.exit(1); '
                    '})'
                ),
            ]
        )

except Exception as exc:
    print(
        f"Patch failed: {exc}",
        file=sys.stderr,
    )

    print(
        "Restoring backup.",
        file=sys.stderr,
    )

    for path in [
        ADMIN_ROUTES,
        POLICY,
        U3Q,
    ]:
        saved = (
            BACKUP
            / path.relative_to(ROOT)
        )

        if saved.exists():
            shutil.copy2(
                saved,
                path,
            )

    if ACTIONS.exists():
        ACTIONS.unlink()

    raise SystemExit(1)


print()
print("PASS — canonical actions.js created")
print("PASS — draft review action set centralised")
print("PASS — listing/requestability action set centralised")
print("PASS — access request review action set centralised")
print("PASS — policy.js now self-contained")
print("PASS — U3-Q uses canonical action definition")
print("PASS — JavaScript syntax validation")
print("PASS — runtime module import validation")
print("PASS — git diff --check")
print()
print(f"Backup retained: {BACKUP}")
