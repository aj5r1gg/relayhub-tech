#!/usr/bin/env python3

"""
U3-CUT — U3-P Controlled Access Request Intake extraction.

Purpose:
  - extract only U3-P from worker/src/upload/admin-routes.js;
  - move U3-P-exclusive functions into:
        worker/src/upload/admin/gates/cdas-access-request-intake.js
  - move genuinely shared helpers into:
        worker/src/upload/admin/common.js
  - preserve the existing route path and dispatcher;
  - preserve U3-Q and all earlier gates;
  - add no new business behaviour;
  - keep U3-R unimplemented and U3-S frozen.

Dry run is the default.
Use --apply only after reviewing the extraction plan.
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
COMMON = ROOT / "worker/src/upload/admin/common.js"

TARGET = (
    ROOT
    / "worker/src/upload/admin/gates/"
    / "cdas-access-request-intake.js"
)

BASE_REFACTOR_SCRIPT = (
    ROOT
    / "scripts/refactor-cdas-upload-admin.py"
)

BACKUP_ROOT = ROOT / ".refactor-backups"


HANDLER = "handleCdasControlledAccessRequestIntake"

EXPECTED_ROUTE = (
    "/api/admin/uploads/cdas-document/access-request"
)

EXPECTED_REVIEW_ROUTE = (
    "/api/admin/uploads/cdas-document/access-request/review"
)

SHARED_FUNCTIONS = {
    "getRequestId",
    "getD1TableColumns",
}

EXPECTED_EXCLUSIVE_FUNCTIONS = {
    "handleCdasControlledAccessRequestIntake",
    "buildCdasControlledAccessRequestId",
    "buildCdasAccessRequestIntakeEventId",
    "normaliseEmail",
    "validateRequesterEmail",
    "normaliseLicenceHolderType",
    "normaliseRecipientCategory",
    "getCdasDocumentForControlledAccessRequest",
    "getLatestListingRequestabilityEventForAccessRequest",
    "getExistingPendingDocumentAccessRequest",
    "insertControlledDocumentAccessRequest",
    "insertControlledAccessRequestIntakeEvent",
}

FORBIDDEN_U3R_HANDLERS = {
    "handleCdasLicencePreparation",
    "handleCdasLicensePreparation",
}


class RefactorError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[U3-P] {message}")


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


def load_structural_tools():
    if not BASE_REFACTOR_SCRIPT.exists():
        fail(
            "Base structural refactor tool is missing: "
            f"{BASE_REFACTOR_SCRIPT.relative_to(ROOT)}"
        )

    spec = importlib.util.spec_from_file_location(
        "cdas_u3_cut_structural_tools",
        BASE_REFACTOR_SCRIPT,
    )

    if spec is None or spec.loader is None:
        fail("Could not load structural refactor helpers.")

    module = importlib.util.module_from_spec(spec)

    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    return module


TOOLS = load_structural_tools()


def top_level_functions(text: str):
    return TOOLS.top_level_functions(text)


def top_level_consts(text: str):
    return TOOLS.top_level_consts(text)


def called_identifiers(block):
    return TOOLS.called_identifiers(block)


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


def parse_imports(text):
    return TOOLS.parse_imports(text)


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
        return statement.rstrip() + "\n\n" + text

    return (
        text[:position].rstrip()
        + "\n"
        + statement.rstrip()
        + "\n\n"
        + text[position:].lstrip("\n")
    )


def named_import(symbols: set[str] | list[str], path: str) -> str:
    names = sorted(symbols)

    if not names:
        fail(
            f"Cannot create empty named import from {path}"
        )

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
            "cdas-u3-p-"
            + datetime.now().strftime(
                "%Y%m%d-%H%M%S"
            )
        )
    )


def backup_files(directory: Path) -> None:
    for path in [
        SOURCE,
        COMMON,
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
    log(
        "Restoring U3-P pre-refactor files."
    )

    for path in [
        SOURCE,
        COMMON,
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

    log(
        "Restore complete."
    )


def build_plan():
    source = SOURCE.read_text(
        encoding="utf-8"
    )

    common = COMMON.read_text(
        encoding="utf-8"
    )

    functions = top_level_functions(
        source
    )

    common_functions = top_level_functions(
        common
    )

    consts = top_level_consts(
        source
    )

    imports = parse_imports(
        source
    )

    if HANDLER not in functions:
        fail(
            f"{HANDLER} is not present in admin-routes.js"
        )

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if forbidden in functions:
            fail(
                "Feature-freeze violation: "
                f"{forbidden} exists."
            )

    if EXPECTED_ROUTE not in source:
        fail(
            "U3-P dispatcher route is missing."
        )

    if EXPECTED_REVIEW_ROUTE not in source:
        fail(
            "U3-Q dispatcher route is missing."
        )

    closure = dependency_closure(
        functions,
        {HANDLER},
    )

    missing_expected = (
        EXPECTED_EXCLUSIVE_FUNCTIONS
        - closure
    )

    if missing_expected:
        fail(
            "Expected U3-P dependency functions "
            "were not discovered: "
            + ", ".join(
                sorted(missing_expected)
            )
        )

    unexpected_shared = (
        SHARED_FUNCTIONS
        - closure
    )

    if unexpected_shared:
        fail(
            "Expected shared dependencies were "
            "not discovered: "
            + ", ".join(
                sorted(unexpected_shared)
            )
        )

    exclusive = (
        closure
        - SHARED_FUNCTIONS
    )

    if exclusive != EXPECTED_EXCLUSIVE_FUNCTIONS:
        extra = (
            exclusive
            - EXPECTED_EXCLUSIVE_FUNCTIONS
        )

        missing = (
            EXPECTED_EXCLUSIVE_FUNCTIONS
            - exclusive
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
            "U3-P exclusive dependency set "
            "changed unexpectedly: "
            + "; ".join(details)
        )

    for name in SHARED_FUNCTIONS:
        if name in common_functions:
            fail(
                f"{name} is already present in "
                "admin/common.js; refusing to duplicate it."
            )

    closure_blocks = [
        functions[name]
        for name in closure
    ]

    remaining = remove_blocks(
        source,
        closure_blocks,
    )

    for name in EXPECTED_EXCLUSIVE_FUNCTIONS:
        if name == HANDLER:
            continue

        if re.search(
            rf"\b{re.escape(name)}\b",
            remaining,
        ):
            fail(
                f"U3-P-exclusive helper {name} "
                "is still referenced outside U3-P."
            )

    for name in SHARED_FUNCTIONS:
        if not re.search(
            rf"\b{re.escape(name)}\b",
            remaining,
        ):
            fail(
                f"Shared helper {name} is no longer "
                "referenced by remaining gates."
            )

    # --------------------------------------------------------------
    # Detect top-level constants referenced by the entire closure.
    #
    # We do not silently relocate constants because that could change
    # ownership semantics. If any appear, dry-run should stop and make
    # us inspect them explicitly.
    # --------------------------------------------------------------

    combined_closure_text = "\n".join(
        functions[name].text
        for name in closure
    )

    # The structural helper's const scanner is intentionally broad and can
    # also discover function-local const declarations. For ownership review
    # here we care only about module-level constant-style identifiers such as:
    #
    #     VALID_FOO_ACTIONS
    #     SOME_POLICY_VALUE
    #
    # Local variables such as body, row, eventAt and values must not be
    # misclassified as shared module constants.
    referenced_consts = {
        name
        for name in consts
        if re.fullmatch(
            r"[A-Z][A-Z0-9_]*",
            name,
        )
        and re.search(
            rf"\b{re.escape(name)}\b",
            combined_closure_text,
        )
    }

    if referenced_consts:
        fail(
            "U3-P references module-level constant-style "
            "identifiers that require explicit ownership review: "
            + ", ".join(
                sorted(referenced_consts)
            )
        )

    # --------------------------------------------------------------
    # Determine existing common.js helpers called from the gate.
    # --------------------------------------------------------------

    gate_common_dependencies = set()

    for name in exclusive:
        block = functions[name]

        for called in called_identifiers(block):
            if called in common_functions:
                gate_common_dependencies.add(
                    called
                )

            if called in SHARED_FUNCTIONS:
                gate_common_dependencies.add(
                    called
                )

    # Shared functions are moved into common.js and therefore are
    # imported by the new gate when required.
    gate_common_dependencies |= SHARED_FUNCTIONS

    # --------------------------------------------------------------
    # External imports required by U3-P.
    # --------------------------------------------------------------

    external_imports = []

    for name in exclusive:
        block = functions[name]

        for called in called_identifiers(block):
            statement = imports.get(called)

            if statement:
                # Dependencies already owned by admin/common.js are imported
                # explicitly by the generated gate from ../common.js. Do not
                # also carry the monolith's ./admin/common.js import across,
                # otherwise the generated module would declare duplicate
                # imported bindings.
                if (
                    'from "./admin/common.js"' in statement
                    or "from './admin/common.js'" in statement
                ):
                    continue

                external_imports.append(
                    statement
                )

    external_imports = list(
        dict.fromkeys(external_imports)
    )

    return {
        "source": source,
        "common": common,
        "functions": functions,
        "common_functions": common_functions,
        "closure": closure,
        "exclusive": exclusive,
        "shared": set(SHARED_FUNCTIONS),
        "gate_common_dependencies":
            gate_common_dependencies,
        "external_imports":
            external_imports,
    }


def print_plan(plan) -> None:
    functions = plan["functions"]

    print()
    print(
        "===== U3-P EXTRACTION PLAN ====="
    )
    print()

    print(
        "U3-P gate functions:"
    )

    for name in sorted(
        plan["exclusive"],
        key=lambda item: (
            functions[item].start
        ),
    ):
        print(
            f"  MOVE -> gate      {name}"
        )

    print()
    print(
        "Shared helpers:"
    )

    for name in sorted(
        plan["shared"],
        key=lambda item: (
            functions[item].start
        ),
    ):
        print(
            f"  MOVE -> common    {name}"
        )

    print()
    print(
        "Existing common helpers imported by U3-P:"
    )

    for name in sorted(
        plan["gate_common_dependencies"]
        - plan["shared"]
    ):
        print(
            f"  IMPORT common     {name}"
        )

    print()
    print(
        "External imports:"
    )

    if plan["external_imports"]:
        for statement in plan[
            "external_imports"
        ]:
            print(
                "  "
                + statement.replace(
                    "\n",
                    "\n  ",
                )
            )
    else:
        print(
            "  none"
        )

    print()
    print(
        "Destination:"
    )

    print(
        "  worker/src/upload/admin/gates/"
        "cdas-access-request-intake.js"
    )

    print()
    print(
        "Preserved dispatcher:"
    )

    print(
        "  /api/admin/uploads/cdas-document/"
        "access-request"
    )

    print()
    print(
        "Feature freeze:"
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


def rewrite_external_import_for_gate(
    statement: str,
) -> str:
    """
    Convert imports relative to:
        worker/src/upload/admin-routes.js

    into imports relative to:
        worker/src/upload/admin/gates/
        cdas-access-request-intake.js
    """

    statement = statement.replace(
        'from "../shared.js"',
        'from "../../../shared.js"',
    )

    statement = statement.replace(
        "from '../shared.js'",
        "from '../../../shared.js'",
    )

    statement = statement.replace(
        'from "./',
        'from "../../',
    )

    statement = statement.replace(
        "from './",
        "from '../../",
    )

    return statement


def build_gate_module(plan) -> str:
    functions = plan["functions"]

    parts = [
        "// U3-P — CDAS Controlled Access Request Intake Gate",
        "// Extracted under U3-CUT.",
        "//",
        "// This gate creates a pending controlled access request and",
        "// intake evidence only. It does not review or approve requests,",
        "// issue licences, generate PDFs, create download links, send",
        "// email, or create direct-download access.",
        "",
    ]

    external_imports = [
        rewrite_external_import_for_gate(
            statement
        )
        for statement in plan[
            "external_imports"
        ]
    ]

    external_imports = list(
        dict.fromkeys(external_imports)
    )

    for statement in external_imports:
        parts.append(
            statement
        )

    if external_imports:
        parts.append(
            ""
        )

    parts.append(
        named_import(
            plan["gate_common_dependencies"],
            "../common.js",
        )
    )

    parts.append(
        ""
    )

    for name in sorted(
        plan["exclusive"],
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

        parts.append(
            ""
        )

    return (
        "\n".join(parts).rstrip()
        + "\n"
    )


def build_common_module(plan) -> str:
    common = plan["common"]
    functions = plan["functions"]

    additions = []

    for name in sorted(
        plan["shared"],
        key=lambda item: (
            functions[item].start
        ),
    ):
        additions.append(
            make_exported(
                functions[name]
            )
        )

        additions.append(
            ""
        )

    return (
        common.rstrip()
        + "\n\n"
        + "\n".join(additions).rstrip()
        + "\n"
    )


def rewrite_admin_routes(plan) -> str:
    source = plan["source"]
    functions = plan["functions"]

    blocks = [
        functions[name]
        for name in plan["closure"]
    ]

    rewritten = remove_blocks(
        source,
        blocks,
    )

    # Remaining gates still use the two helpers that have moved to
    # admin/common.js.
    rewritten = add_import(
        rewritten,
        named_import(
            plan["shared"],
            "./admin/common.js",
        ),
    )

    # U3-P dispatcher now imports the extracted handler.
    rewritten = add_import(
        rewritten,
        (
            "import { "
            "handleCdasControlledAccessRequestIntake "
            "} from "
            '"./admin/gates/'
            'cdas-access-request-intake.js";'
        ),
    )

    if EXPECTED_ROUTE not in rewritten:
        fail(
            "U3-P route disappeared during rewrite."
        )

    if (
        "return "
        "handleCdasControlledAccessRequestIntake"
        "(request, env);"
        not in rewritten
    ):
        fail(
            "U3-P dispatcher call disappeared."
        )

    if TOOLS.find_function(
        rewritten,
        HANDLER,
    ):
        fail(
            "U3-P handler remains inline."
        )

    return rewritten


def validate() -> None:
    paths = [
        SOURCE,
        COMMON,
        TARGET,
        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-access-request-review.js",
        ROOT
        / "worker/src/upload/admin/actions.js",
        ROOT
        / "worker/src/upload/admin/policy.js",
    ]

    for path in paths:
        if not path.exists():
            fail(
                f"Expected validation file missing: "
                f"{path.relative_to(ROOT)}"
            )

        result = run(
            [
                "node",
                "--check",
                str(
                    path.relative_to(ROOT)
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
                "JavaScript syntax validation failed: "
                f"{path.relative_to(ROOT)}"
            )

    # These modules do not require Cloudflare-specific imports and can
    # be loaded directly by Node.
    modules = [
        (
            "common",
            "./worker/src/upload/admin/common.js",
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
                f"Runtime module import failed: "
                f"{label}"
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

    common = COMMON.read_text(
        encoding="utf-8"
    )

    gate = TARGET.read_text(
        encoding="utf-8"
    )

    source_functions = top_level_functions(
        source
    )

    common_functions = top_level_functions(
        common
    )

    gate_functions = top_level_functions(
        gate
    )

    if HANDLER in source_functions:
        fail(
            "Postcondition failed: "
            "U3-P handler remains in monolith."
        )

    if HANDLER not in gate_functions:
        fail(
            "Postcondition failed: "
            "U3-P handler missing from gate."
        )

    for name in (
        EXPECTED_EXCLUSIVE_FUNCTIONS
        - {HANDLER}
    ):
        if name in source_functions:
            fail(
                "Postcondition failed: "
                f"{name} remains in monolith."
            )

        if name not in gate_functions:
            fail(
                "Postcondition failed: "
                f"{name} missing from U3-P gate."
            )

    for name in SHARED_FUNCTIONS:
        if name in source_functions:
            fail(
                "Postcondition failed: "
                f"{name} remains in monolith."
            )

        if name not in common_functions:
            fail(
                "Postcondition failed: "
                f"{name} missing from common.js."
            )

    if (
        'from "./admin/gates/'
        'cdas-access-request-intake.js"'
        not in source
    ):
        fail(
            "Postcondition failed: "
            "U3-P import missing from dispatcher."
        )

    if EXPECTED_ROUTE not in source:
        fail(
            "Postcondition failed: "
            "U3-P route missing."
        )

    if EXPECTED_REVIEW_ROUTE not in source:
        fail(
            "Postcondition failed: "
            "U3-Q route missing."
        )

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if (
            forbidden in source
            or forbidden in gate
        ):
            fail(
                "Postcondition failed: "
                f"{forbidden} appeared."
            )

    log(
        "Structural postconditions PASS."
    )


def report(before_lines: int) -> None:
    source_lines = len(
        SOURCE.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    gate_lines = len(
        TARGET.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    common_lines = len(
        COMMON.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    print()
    print(
        "===== U3-P EXTRACTION RESULT ====="
    )
    print()

    print(
        f"admin-routes.js: "
        f"{before_lines} -> "
        f"{source_lines} lines"
    )

    print(
        f"U3-P gate:       "
        f"{gate_lines} lines"
    )

    print(
        f"admin/common.js: "
        f"{common_lines} lines"
    )

    print()
    print(
        "PASS — U3-P extracted"
    )

    print(
        "PASS — getRequestId moved to common"
    )

    print(
        "PASS — getD1TableColumns moved to common"
    )

    print(
        "PASS — dispatcher preserved"
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
            "Extract U3-P Controlled Access "
            "Request Intake from CDAS upload admin."
        )
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply the U3-P extraction. "
            "Default is dry run."
        ),
    )

    args = parser.parse_args()

    directory = None

    try:
        if not SOURCE.exists():
            fail(
                "admin-routes.js is missing."
            )

        if not COMMON.exists():
            fail(
                "admin/common.js is missing."
            )

        if TARGET.exists():
            fail(
                "U3-P target module already exists."
            )

        source = SOURCE.read_text(
            encoding="utf-8"
        )

        before_lines = len(
            source.splitlines()
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

        directory = backup_directory()

        directory.mkdir(
            parents=True,
            exist_ok=False,
        )

        backup_files(
            directory
        )

        TARGET.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        gate_text = build_gate_module(
            plan
        )

        common_text = build_common_module(
            plan
        )

        source_text = rewrite_admin_routes(
            plan
        )

        TARGET.write_text(
            gate_text,
            encoding="utf-8",
        )

        COMMON.write_text(
            common_text,
            encoding="utf-8",
        )

        SOURCE.write_text(
            source_text,
            encoding="utf-8",
        )

        validate()
        postconditions()

        report(
            before_lines
        )

        log(
            f"Backup retained at {directory}"
        )

        return 0

    except RefactorError as exc:
        print()
        print(
            f"U3-P EXTRACTION FAILED: {exc}",
            file=sys.stderr,
        )

        if (
            directory is not None
            and directory.exists()
        ):
            try:
                restore(
                    directory
                )
            except Exception as restore_exc:
                print(
                    "RESTORE FAILED: "
                    f"{restore_exc}",
                    file=sys.stderr,
                )

        return 1


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
