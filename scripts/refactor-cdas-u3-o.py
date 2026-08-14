#!/usr/bin/env python3

"""
U3-CUT — U3-O Controlled Listing and Requestability extraction.

Extracts only U3-O from worker/src/upload/admin-routes.js into:

    worker/src/upload/admin/gates/cdas-listing-requestability.js

No new workflow capability is introduced.
U3-P and U3-Q remain extracted.
U3-R remains unimplemented.
U3-S remains frozen.

Dry run is the default.
Use --apply only after reviewing the plan.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import shutil
import subprocess
import sys

from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

SOURCE = ROOT / "worker/src/upload/admin-routes.js"

TARGET = (
    ROOT
    / "worker/src/upload/admin/gates/"
    / "cdas-listing-requestability.js"
)

BASE_REFACTOR_SCRIPT = (
    ROOT
    / "scripts/refactor-cdas-upload-admin.py"
)

BACKUP_ROOT = ROOT / ".refactor-backups"

HANDLER = "handleCdasControlledListingRequestability"

EXPECTED_ROUTE = (
    "/api/admin/uploads/cdas-document/"
    "listing-requestability"
)

EXPECTED_FUNCTIONS = {
    "handleCdasControlledListingRequestability",
    "buildCdasListingRequestabilityEventId",
    "normaliseListingRequestabilityAction",
    "validateCdasListingRequestabilityAction",
    "getLatestCdasActivationEvent",
    "getCdasActiveDocumentForListingRequestability",
    "buildCdasListingRequestabilityOutcome",
    "updateCdasDocumentListingRequestability",
    "insertCdasListingRequestabilityEvent",
}

ACTION_CONSTANT = (
    "VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS"
)

FORBIDDEN_U3R_HANDLERS = {
    "handleCdasLicencePreparation",
    "handleCdasLicensePreparation",
}


class RefactorError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[U3-O] {message}")


def fail(message: str) -> None:
    raise RefactorError(message)


def run(command: list[str]) -> subprocess.CompletedProcess:
    log("$ " + " ".join(command))

    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
    )


def load_tools():
    spec = importlib.util.spec_from_file_location(
        "cdas_u3_cut_structural_tools",
        BASE_REFACTOR_SCRIPT,
    )

    if spec is None or spec.loader is None:
        fail(
            "Could not load structural refactor helpers."
        )

    module = importlib.util.module_from_spec(spec)

    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    return module


TOOLS = load_tools()


def top_level_functions(text: str):
    return TOOLS.top_level_functions(text)


def dependency_closure(functions, seed):
    return TOOLS.dependency_closure(
        functions,
        seed,
    )


def remove_blocks(text, blocks):
    return TOOLS.remove_blocks(
        text,
        blocks,
    )


def make_exported(block):
    return TOOLS.make_exported(block)


def called_identifiers(block):
    return TOOLS.called_identifiers(block)


def insertion_after_imports(text: str) -> int:
    matches = list(
        re.finditer(
            r"(?ms)^[ \t]*import\b.*?;"
            r"[ \t]*(?:\r?\n)?",
            text,
        )
    )

    return matches[-1].end() if matches else 0


def add_import(text: str, statement: str) -> str:
    if statement.strip() in text:
        return text

    position = insertion_after_imports(text)

    if position == 0:
        return (
            statement.rstrip()
            + "\n\n"
            + text
        )

    return (
        text[:position].rstrip()
        + "\n"
        + statement.rstrip()
        + "\n\n"
        + text[position:].lstrip("\n")
    )


def named_import(
    names: set[str] | list[str],
    path: str,
) -> str:
    names = sorted(names)

    if len(names) == 1:
        return (
            f'import {{ {names[0]} }} '
            f'from "{path}";'
        )

    return (
        "import {\n"
        + "".join(
            f"  {name},\n"
            for name in names
        )
        + f'}} from "{path}";'
    )


def backup_directory() -> Path:
    return (
        BACKUP_ROOT
        / (
            "cdas-u3-o-"
            + datetime.now().strftime(
                "%Y%m%d-%H%M%S"
            )
        )
    )


def backup_files(directory: Path) -> None:
    for path in [
        SOURCE,
        TARGET,
    ]:
        if not path.exists():
            continue

        destination = (
            directory
            / path.relative_to(ROOT)
        )

        destination.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        shutil.copy2(
            path,
            destination,
        )

    log(
        f"Backup created at {directory}"
    )


def restore(directory: Path) -> None:
    log("Restoring U3-O pre-refactor files.")

    for path in [
        SOURCE,
        TARGET,
    ]:
        backup = (
            directory
            / path.relative_to(ROOT)
        )

        if backup.exists():
            path.parent.mkdir(
                parents=True,
                exist_ok=True,
            )

            shutil.copy2(
                backup,
                path,
            )

        elif path == TARGET and path.exists():
            path.unlink()

    log("Restore complete.")


def build_plan():
    source = SOURCE.read_text(
        encoding="utf-8"
    )

    functions = top_level_functions(source)

    if HANDLER not in functions:
        fail(
            f"{HANDLER} not found."
        )

    closure = dependency_closure(
        functions,
        {HANDLER},
    )

    if closure != EXPECTED_FUNCTIONS:
        extra = (
            closure
            - EXPECTED_FUNCTIONS
        )

        missing = (
            EXPECTED_FUNCTIONS
            - closure
        )

        details = []

        if extra:
            details.append(
                "extra="
                + ",".join(sorted(extra))
            )

        if missing:
            details.append(
                "missing="
                + ",".join(sorted(missing))
            )

        fail(
            "U3-O dependency closure changed: "
            + "; ".join(details)
        )

    remaining = remove_blocks(
        source,
        [
            functions[name]
            for name in closure
        ],
    )

    for name in closure:
        if name == HANDLER:
            continue

        if re.search(
            rf"\b{re.escape(name)}\b",
            remaining,
        ):
            fail(
                f"U3-O helper {name} "
                "is referenced outside U3-O."
            )

    if EXPECTED_ROUTE not in source:
        fail(
            "U3-O route is missing."
        )

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if forbidden in functions:
            fail(
                "Feature freeze violation: "
                f"{forbidden} exists."
            )

    # Existing shared dependencies already exported by admin/common.js.
    common_dependencies = {
        "buildSideEffectsConfirmed",
        "cdasUploadsDisabledResponse",
        "cleanText",
        "envEnabled",
        "fail",
        "getAdminActor",
        "getRequestId",
        "getUploadRouteSwitches",
        "methodNotAllowed",
        "nowIso",
        "nullableText",
        "pass",
        "readJsonBody",
        "uploadSystemDisabledResponse",
    }

    # Verify every declared common dependency is actually used somewhere
    # in the U3-O closure. This catches stale assumptions.
    closure_text = "\n".join(
        functions[name].text
        for name in closure
    )

    unused_common = {
        name
        for name in common_dependencies
        if not re.search(
            rf"\b{re.escape(name)}\b",
            closure_text,
        )
    }

    if unused_common:
        fail(
            "Declared U3-O common dependencies "
            "are not used: "
            + ", ".join(
                sorted(unused_common)
            )
        )

    if ACTION_CONSTANT not in closure_text:
        fail(
            f"{ACTION_CONSTANT} is not referenced "
            "by U3-O as expected."
        )

    return {
        "source": source,
        "functions": functions,
        "closure": closure,
        "common_dependencies":
            common_dependencies,
    }


def print_plan(plan) -> None:
    functions = plan["functions"]

    print()
    print(
        "===== U3-O EXTRACTION PLAN ====="
    )
    print()

    print("U3-O gate functions:")

    for name in sorted(
        plan["closure"],
        key=lambda item: (
            functions[item].start
        ),
    ):
        print(
            f"  MOVE -> gate      {name}"
        )

    print()
    print("Shared helpers:")

    for name in sorted(
        plan["common_dependencies"]
    ):
        print(
            f"  IMPORT common     {name}"
        )

    print()
    print("Canonical action definition:")

    print(
        "  IMPORT actions    "
        + ACTION_CONSTANT
    )

    print()
    print("External import:")

    print(
        '  import { jsonResponse } '
        'from "../../../shared.js";'
    )

    print()
    print("Destination:")

    print(
        "  worker/src/upload/admin/gates/"
        "cdas-listing-requestability.js"
    )

    print()
    print("Preserved dispatcher:")

    print(
        "  " + EXPECTED_ROUTE
    )

    print()
    print("Feature freeze:")

    print(
        "  U3-P remains extracted"
    )

    print(
        "  U3-Q remains extracted"
    )

    print(
        "  U3-R remains unimplemented"
    )

    print(
        "  U3-S remains deferred"
    )

    print()


def build_gate_module(plan) -> str:
    functions = plan["functions"]

    parts = [
        "// U3-O — CDAS Controlled Listing and Requestability Gate",
        "// Extracted under U3-CUT.",
        "//",
        "// This gate controls listing and requestability only.",
        "// It does not create access requests, approve access, issue",
        "// licences, generate PDFs, create download links, send email,",
        "// or create direct-download access.",
        "",
        'import { jsonResponse } from "../../../shared.js";',
        "",
        named_import(
            {ACTION_CONSTANT},
            "../actions.js",
        ),
        "",
        named_import(
            plan["common_dependencies"],
            "../common.js",
        ),
        "",
    ]

    for name in sorted(
        plan["closure"],
        key=lambda item: (
            functions[item].start
        ),
    ):
        block = functions[name]

        if name == HANDLER:
            parts.append(
                make_exported(block)
            )
        else:
            parts.append(
                block.text.rstrip()
            )

        parts.append("")

    return (
        "\n".join(parts).rstrip()
        + "\n"
    )


def rewrite_admin_routes(plan) -> str:
    source = plan["source"]
    functions = plan["functions"]

    rewritten = remove_blocks(
        source,
        [
            functions[name]
            for name in plan["closure"]
        ],
    )

    rewritten = add_import(
        rewritten,
        (
            "import { "
            "handleCdasControlledListingRequestability "
            "} from "
            '"./admin/gates/'
            'cdas-listing-requestability.js";'
        ),
    )

    if EXPECTED_ROUTE not in rewritten:
        fail(
            "U3-O route disappeared during rewrite."
        )

    if (
        "return "
        "handleCdasControlledListingRequestability"
        "(request, env);"
        not in rewritten
    ):
        fail(
            "U3-O dispatcher call disappeared."
        )

    source_functions = top_level_functions(
        rewritten
    )

    if HANDLER in source_functions:
        fail(
            "U3-O handler remains inline."
        )

    return rewritten


def validate() -> None:
    paths = [
        SOURCE,
        TARGET,
        ROOT
        / "worker/src/upload/admin/common.js",
        ROOT
        / "worker/src/upload/admin/actions.js",
        ROOT
        / "worker/src/upload/admin/policy.js",
        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-access-request-intake.js",
        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-access-request-review.js",
    ]

    for path in paths:
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
                "JavaScript syntax failed: "
                f"{path.relative_to(ROOT)}"
            )

    modules = [
        (
            "U3-O",
            "./worker/src/upload/admin/gates/"
            "cdas-listing-requestability.js",
        ),
        (
            "U3-P",
            "./worker/src/upload/admin/gates/"
            "cdas-access-request-intake.js",
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

    for label, module in modules:
        result = run(
            [
                "node",
                "-e",
                (
                    f'import("{module}")'
                    f'.then(() => '
                    f'console.log("PASS {label} import"))'
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


def postconditions() -> None:
    source = SOURCE.read_text(
        encoding="utf-8"
    )

    gate = TARGET.read_text(
        encoding="utf-8"
    )

    source_functions = top_level_functions(
        source
    )

    gate_functions = top_level_functions(
        gate
    )

    for name in EXPECTED_FUNCTIONS:
        if name in source_functions:
            fail(
                f"{name} remains in admin-routes.js"
            )

        if name not in gate_functions:
            fail(
                f"{name} missing from U3-O gate"
            )

    if (
        'from "./admin/gates/'
        'cdas-listing-requestability.js"'
        not in source
    ):
        fail(
            "U3-O dispatcher import missing."
        )

    if EXPECTED_ROUTE not in source:
        fail(
            "U3-O route missing."
        )

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if forbidden in source or forbidden in gate:
            fail(
                f"Feature freeze violation: "
                f"{forbidden} appeared."
            )

    log(
        "Structural postconditions PASS."
    )


def report(before_lines: int) -> None:
    after_lines = len(
        SOURCE.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    gate_lines = len(
        TARGET.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    print()
    print(
        "===== U3-O EXTRACTION RESULT ====="
    )
    print()

    print(
        f"admin-routes.js: "
        f"{before_lines} -> "
        f"{after_lines} lines"
    )

    print(
        f"U3-O gate:       "
        f"{gate_lines} lines"
    )

    print()
    print(
        "PASS — U3-O extracted"
    )

    print(
        "PASS — dispatcher preserved"
    )

    print(
        "PASS — canonical action vocabulary preserved"
    )

    print(
        "PASS — U3-P preserved"
    )

    print(
        "PASS — U3-Q preserved"
    )

    print(
        "PASS — JavaScript syntax"
    )

    print(
        "PASS — runtime module imports"
    )

    print(
        "PASS — git diff --check"
    )

    print(
        "PASS — U3-R remains unimplemented"
    )

    print(
        "PASS — U3-S remains frozen"
    )

    print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract U3-O Controlled Listing "
            "and Requestability Gate."
        )
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply U3-O extraction. "
            "Default is dry run."
        ),
    )

    args = parser.parse_args()

    backup = None

    try:
        if not SOURCE.exists():
            fail(
                "admin-routes.js is missing."
            )

        if TARGET.exists():
            fail(
                "U3-O target module already exists."
            )

        before_lines = len(
            SOURCE.read_text(
                encoding="utf-8"
            ).splitlines()
        )

        plan = build_plan()

        print_plan(plan)

        if not args.apply:
            log(
                "DRY RUN ONLY — no files changed."
            )

            log(
                "Review the extraction plan "
                "before using --apply."
            )

            return 0

        backup = backup_directory()

        backup.mkdir(
            parents=True,
            exist_ok=False,
        )

        backup_files(backup)

        TARGET.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        TARGET.write_text(
            build_gate_module(plan),
            encoding="utf-8",
        )

        SOURCE.write_text(
            rewrite_admin_routes(plan),
            encoding="utf-8",
        )

        validate()
        postconditions()

        report(before_lines)

        log(
            f"Backup retained at {backup}"
        )

        return 0

    except RefactorError as exc:
        print()
        print(
            f"U3-O EXTRACTION FAILED: {exc}",
            file=sys.stderr,
        )

        if (
            backup is not None
            and backup.exists()
        ):
            try:
                restore(backup)
            except Exception as restore_exc:
                print(
                    "RESTORE FAILED: "
                    f"{restore_exc}",
                    file=sys.stderr,
                )

        return 1


if __name__ == "__main__":
    raise SystemExit(main())
