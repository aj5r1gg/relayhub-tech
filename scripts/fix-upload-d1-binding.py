#!/usr/bin/env python3

"""
U3-CUT — Correct upload subsystem D1 binding.

Canonical Worker binding:
    env.RELAYHUB_DB

Incorrect upload-subsystem binding:
    env.DB
    env?.DB

This script performs a guarded mechanical replacement only within:

    worker/src/upload/

It does NOT alter SQL, workflow states, policies, routes, or business logic.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys

from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UPLOAD_ROOT = ROOT / "worker/src/upload"

BACKUP = (
    ROOT
    / ".refactor-backups"
    / f"upload-d1-binding-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
)

CANONICAL_BINDING = "RELAYHUB_DB"


class FixError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[D1-BINDING] {message}")


def fail(message: str) -> None:
    raise FixError(message)


def run(command: list[str]) -> subprocess.CompletedProcess:
    log("$ " + " ".join(command))

    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
    )


def javascript_files() -> list[Path]:
    return sorted(
        path
        for path in UPLOAD_ROOT.rglob("*.js")
        if path.is_file()
    )


def incorrect_references(text: str) -> int:
    patterns = [
        r"\benv\.DB\b",
        r"\benv\?\.DB\b",
    ]

    return sum(
        len(re.findall(pattern, text))
        for pattern in patterns
    )


def backup_file(path: Path) -> None:
    destination = BACKUP / path.relative_to(ROOT)

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    shutil.copy2(
        path,
        destination,
    )


def restore(changed_files: list[Path]) -> None:
    log("Restoring files from backup.")

    for path in changed_files:
        saved = BACKUP / path.relative_to(ROOT)

        if saved.exists():
            shutil.copy2(
                saved,
                path,
            )

    log("Restore complete.")


def main() -> int:
    changed_files: list[Path] = []

    try:
        if not UPLOAD_ROOT.exists():
            fail(
                f"Upload source directory is missing: "
                f"{UPLOAD_ROOT.relative_to(ROOT)}"
            )

        files = javascript_files()

        if not files:
            fail("No JavaScript files found under worker/src/upload.")

        candidates = []

        total_direct = 0
        total_optional = 0

        for path in files:
            text = path.read_text(encoding="utf-8")

            direct = len(
                re.findall(
                    r"\benv\.DB\b",
                    text,
                )
            )

            optional = len(
                re.findall(
                    r"\benv\?\.DB\b",
                    text,
                )
            )

            if direct or optional:
                candidates.append(
                    (
                        path,
                        direct,
                        optional,
                    )
                )

                total_direct += direct
                total_optional += optional

        print()
        print("===== D1 BINDING CORRECTION PLAN =====")
        print()

        if not candidates:
            print(
                "No env.DB or env?.DB references found."
            )
            return 0

        for path, direct, optional in candidates:
            print(
                f"{path.relative_to(ROOT)}"
                f"  env.DB={direct}"
                f"  env?.DB={optional}"
            )

        print()
        print(f"Files affected:          {len(candidates)}")
        print(f"env.DB references:       {total_direct}")
        print(f"env?.DB references:      {total_optional}")
        print(
            f"Total replacements:      "
            f"{total_direct + total_optional}"
        )
        print()
        print(
            "Replacement target:      "
            "env.RELAYHUB_DB / env?.RELAYHUB_DB"
        )
        print()

        BACKUP.mkdir(
            parents=True,
            exist_ok=False,
        )

        for path, _, _ in candidates:
            backup_file(path)

        log(f"Backup created at {BACKUP}")

        for path, expected_direct, expected_optional in candidates:
            original = path.read_text(
                encoding="utf-8"
            )

            updated = original

            # Do optional-chain replacement first.
            updated, optional_count = re.subn(
                r"\benv\?\.DB\b",
                "env?.RELAYHUB_DB",
                updated,
            )

            updated, direct_count = re.subn(
                r"\benv\.DB\b",
                "env.RELAYHUB_DB",
                updated,
            )

            if optional_count != expected_optional:
                fail(
                    f"Unexpected optional replacement count for "
                    f"{path.relative_to(ROOT)}: "
                    f"expected {expected_optional}, "
                    f"got {optional_count}"
                )

            if direct_count != expected_direct:
                fail(
                    f"Unexpected direct replacement count for "
                    f"{path.relative_to(ROOT)}: "
                    f"expected {expected_direct}, "
                    f"got {direct_count}"
                )

            if updated == original:
                fail(
                    f"Candidate file did not change: "
                    f"{path.relative_to(ROOT)}"
                )

            path.write_text(
                updated,
                encoding="utf-8",
            )

            changed_files.append(path)

        # --------------------------------------------------------------
        # Hard postcondition: wrong binding must be gone from upload tree.
        # --------------------------------------------------------------

        remaining = []

        for path in javascript_files():
            text = path.read_text(
                encoding="utf-8"
            )

            if re.search(
                r"\benv(?:\?\.)?\.DB\b",
                text,
            ):
                remaining.append(
                    path.relative_to(ROOT)
                )

        if remaining:
            fail(
                "Incorrect env.DB binding references remain in: "
                + ", ".join(
                    str(path)
                    for path in remaining
                )
            )

        log(
            "PASS — no env.DB/env?.DB references remain "
            "under worker/src/upload."
        )

        # --------------------------------------------------------------
        # Syntax validation for every JS file in upload subsystem.
        # --------------------------------------------------------------

        for path in javascript_files():
            result = run(
                [
                    "node",
                    "--check",
                    str(path.relative_to(ROOT)),
                ]
            )

            if result.returncode != 0:
                if result.stdout:
                    print(result.stdout)

                if result.stderr:
                    print(
                        result.stderr,
                        file=sys.stderr,
                    )

                fail(
                    f"node --check failed for "
                    f"{path.relative_to(ROOT)}"
                )

        log(
            "PASS — all upload JavaScript files parse."
        )

        # --------------------------------------------------------------
        # Runtime module validation for critical refactored path.
        # --------------------------------------------------------------

        runtime_modules = [
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
                "./worker/src/upload/admin/gates/"
                "cdas-access-request-review.js",
            ),
            (
                "admin-routes",
                "./worker/src/upload/admin-routes.js",
            ),
        ]

        for label, module in runtime_modules:
            result = run(
                [
                    "node",
                    "-e",
                    (
                        f'import("{module}")'
                        f'.then(() => console.log('
                        f'"PASS {label} import"))'
                        f'.catch(e => {{ '
                        f'console.error(e); '
                        f'process.exit(1); '
                        f'}})'
                    ),
                ]
            )

            if result.returncode != 0:
                if result.stdout:
                    print(result.stdout)

                if result.stderr:
                    print(
                        result.stderr,
                        file=sys.stderr,
                    )

                fail(
                    f"Runtime import failed: {label}"
                )

        log(
            "PASS — critical runtime module imports."
        )

        # --------------------------------------------------------------
        # Git whitespace validation.
        # --------------------------------------------------------------

        result = run(
            [
                "git",
                "diff",
                "--check",
            ]
        )

        if result.returncode != 0:
            if result.stdout:
                print(result.stdout)

            if result.stderr:
                print(
                    result.stderr,
                    file=sys.stderr,
                )

            fail(
                "git diff --check failed."
            )

        log(
            "PASS — git diff --check."
        )

        # --------------------------------------------------------------
        # Report canonical binding usage.
        # --------------------------------------------------------------

        canonical_count = 0

        for path in javascript_files():
            text = path.read_text(
                encoding="utf-8"
            )

            canonical_count += len(
                re.findall(
                    r"\benv(?:\?\.)?\.RELAYHUB_DB\b",
                    text,
                )
            )

        print()
        print("===== D1 BINDING CORRECTION RESULT =====")
        print()
        print(
            f"Changed files:                  "
            f"{len(changed_files)}"
        )
        print(
            f"Replacements made:             "
            f"{total_direct + total_optional}"
        )
        print(
            f"RELAYHUB_DB references now:    "
            f"{canonical_count}"
        )
        print()
        print(
            "PASS — upload subsystem uses canonical D1 binding"
        )
        print(
            "PASS — no env.DB references remain"
        )
        print(
            "PASS — JavaScript syntax"
        )
        print(
            "PASS — critical module imports"
        )
        print(
            "PASS — git diff --check"
        )
        print()
        print(
            f"Backup retained: {BACKUP}"
        )

        return 0

    except FixError as exc:
        print()
        print(
            f"D1 BINDING FIX FAILED: {exc}",
            file=sys.stderr,
        )

        if BACKUP.exists():
            try:
                restore(changed_files)

            except Exception as restore_exc:
                print(
                    f"RESTORE FAILED: {restore_exc}",
                    file=sys.stderr,
                )

        return 1


if __name__ == "__main__":
    raise SystemExit(main())
