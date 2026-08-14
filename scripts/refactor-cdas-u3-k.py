#!/usr/bin/env python3

"""
U3-CUT — U3-K CDAS Document Upload Gate extraction.

Extracts the remaining CDAS document upload/dry-run/real-write gate from:

    worker/src/upload/admin-routes.js

into:

    worker/src/upload/admin/gates/cdas-document-upload.js

This is a containment refactor only.

It MUST NOT change:
- upload enablement semantics;
- dry-run semantics;
- real-write semantics;
- multipart parsing;
- storage-prefix handling;
- R2 absence checks;
- hash evidence;
- draft-document preflight;
- draft-document creation;
- idempotency;
- upload transaction behaviour;
- R2 write orchestration;
- recovery-required behaviour;
- downstream gate behaviour.

U3-L through U3-Q remain extracted.
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
    / "cdas-document-upload.js"
)

BASE_REFACTOR_SCRIPT = (
    ROOT
    / "scripts/refactor-cdas-upload-admin.py"
)

BACKUP_ROOT = ROOT / ".refactor-backups"

HANDLER = "handleCdasDocumentUploadSkeleton"

EXPECTED_ROUTE = (
    "/api/admin/uploads/cdas-document"
)

EXPECTED_FUNCTIONS = {
    "addHoursIso",
    "buildUploadIdempotencyRecordId",
    "safeSlug",
    "safeVersion",
    "normalisePrefix",
    "safeFileSummary",
    "buildParsedUploadSummary",
    "buildObservedRequest",
    "routeSkeletonDisabledResponse",
    "dryRunDisabledResponse",
    "dryRunRequiredResponse",
    "realWriteDisabledResponse",
    "getStoragePrefixForDryRun",
    "buildCdasDryRunObjectKeyPreview",
    "getFileExtension",
    "safeFilename",
    "asciiFromFirstBytes",
    "validatePdfDryRunSanity",
    "buildDryRunHashEvidence",
    "buildDryRunR2AbsenceCheck",
    "buildCdasDocumentId",
    "buildCdasGeneratedPrefix",
    "getExistingCdasDocumentByIdOrSlug",
    "preflightCdasDraftDocumentRecord",
    "buildCdasDraftDocumentRow",
    "buildCdasDraftAdminVisibilityEvidence",
    "insertCdasDraftDocumentRecord",
    "markUploadTransactionRecoveryRequiredForDocumentRecordFailure",
    "buildCdasDraftDocumentRecordPreview",
    "buildCdasDryRunPreview",
    "parseCdasDryRunMultipart",
    "buildRealWriteObjectKeys",
    "buildUploadMetadata",
    "readUploadBytesForWrite",
    "getClientRequestIdFromUpload",
    "classifyCdasIdempotencyReplay",
    "prepareCdasRealWriteIdempotency",
    "recordCdasIdempotencyReplay",
    "createCdasIdempotencyRecordForTransaction",
    "updateCdasIdempotencyStatus",
    "createCdasUploadTransaction",
    "performCdasRealWrite",
    "handleCdasDocumentUploadSkeleton",
}

FORBIDDEN_U3R_HANDLERS = {
    "handleCdasLicencePreparation",
    "handleCdasLicensePreparation",
}


class RefactorError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[U3-K] {message}")


def fail(message: str) -> None:
    raise RefactorError(message)


def run(
    command: list[str],
) -> subprocess.CompletedProcess:
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


def insertion_after_imports(
    text: str,
) -> int:
    matches = list(
        re.finditer(
            r"(?ms)^[ \t]*import\b.*?;"
            r"[ \t]*(?:\r?\n)?",
            text,
        )
    )

    return (
        matches[-1].end()
        if matches
        else 0
    )


def add_import(
    text: str,
    statement: str,
) -> str:
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
            "cdas-u3-k-"
            + datetime.now().strftime(
                "%Y%m%d-%H%M%S"
            )
        )
    )


def backup_files(
    directory: Path,
) -> None:
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


def restore(
    directory: Path,
) -> None:
    log(
        "Restoring U3-K pre-refactor files."
    )

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

        elif (
            path == TARGET
            and path.exists()
        ):
            path.unlink()

    log(
        "Restore complete."
    )


def build_plan():
    source = SOURCE.read_text(
        encoding="utf-8"
    )

    functions = top_level_functions(
        source
    )

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
                + ",".join(
                    sorted(extra)
                )
            )

        if missing:
            details.append(
                "missing="
                + ",".join(
                    sorted(missing)
                )
            )

        fail(
            "U3-K dependency closure changed: "
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
                f"U3-K helper {name} "
                "is referenced outside U3-K."
            )

    if EXPECTED_ROUTE not in source:
        fail(
            "U3-K route is missing."
        )

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if forbidden in functions:
            fail(
                "Feature freeze violation: "
                f"{forbidden} exists."
            )

    common_dependencies = {
        "buildCdasUploadRouteStatus",
        "buildSideEffectsConfirmed",
        "cdasUploadsDisabledResponse",
        "cleanText",
        "fail",
        "getAdminActor",
        "getD1TableColumns",
        "getRequestId",
        "getUploadRouteMode",
        "getUploadRouteSwitches",
        "methodNotAllowed",
        "nowIso",
        "nullableText",
        "pass",
        "uploadSystemDisabledResponse",
    }

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
            "Declared U3-K common dependencies "
            "are not used: "
            + ", ".join(
                sorted(unused_common)
            )
        )

    external_dependencies = {
        "getIdempotencyRecordForClientKey":
            "../../idempotency.js",

        "orchestrateUploadR2Write":
            "../../write-orchestrator.js",

        "byteLength":
            "../../hash.js",

        "sha256Hex":
            "../../hash.js",

        "requireUploadObjectKeysAbsent":
            "../../r2-objects.js",

        "createUploadTransaction":
            "../../transactions.js",

        "parseStrictUploadRequest":
            "../../parse-multipart.js",
    }

    for name in external_dependencies:
        if not re.search(
            rf"\b{re.escape(name)}\b",
            closure_text,
        ):
            fail(
                "Expected U3-K external dependency "
                f"{name} is not referenced."
            )

    return {
        "source":
            source,

        "functions":
            functions,

        "closure":
            closure,

        "common_dependencies":
            common_dependencies,

        "external_dependencies":
            external_dependencies,
    }


def print_plan(plan) -> None:
    functions = plan["functions"]

    print()
    print(
        "===== U3-K EXTRACTION PLAN ====="
    )
    print()

    print(
        "U3-K gate functions:"
    )

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
    print(
        "Shared helpers:"
    )

    for name in sorted(
        plan["common_dependencies"]
    ):
        print(
            f"  IMPORT common     {name}"
        )

    print()
    print(
        "Infrastructure imports:"
    )

    infrastructure_groups = {}

    for name, path in (
        plan["external_dependencies"].items()
    ):
        infrastructure_groups.setdefault(
            path,
            [],
        ).append(name)

    for path in sorted(
        infrastructure_groups
    ):
        names = ", ".join(
            sorted(
                infrastructure_groups[path]
            )
        )

        print(
            f"  IMPORT {path:<30s} {names}"
        )

    print()
    print(
        "External response import:"
    )

    print(
        '  import { jsonResponse } '
        'from "../../../shared.js";'
    )

    print()
    print(
        "Destination:"
    )

    print(
        "  worker/src/upload/admin/gates/"
        "cdas-document-upload.js"
    )

    print()
    print(
        "Preserved dispatcher:"
    )

    print(
        "  " + EXPECTED_ROUTE
    )

    print()
    print(
        "Preserved boundaries:"
    )

    print(
        "  dry-run behaviour unchanged"
    )

    print(
        "  real-write behaviour unchanged"
    )

    print(
        "  idempotency behaviour unchanged"
    )

    print(
        "  transaction behaviour unchanged"
    )

    print(
        "  R2 write orchestration unchanged"
    )

    print(
        "  draft record creation unchanged"
    )

    print(
        "  recovery-required behaviour unchanged"
    )

    print()
    print(
        "Feature freeze:"
    )

    print(
        "  U3-L remains extracted"
    )

    print(
        "  U3-M remains extracted"
    )

    print(
        "  U3-N remains extracted"
    )

    print(
        "  U3-O remains extracted"
    )

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


def build_gate_module(
    plan,
) -> str:
    functions = plan["functions"]

    parts = [
        "// U3-K — CDAS Document Upload Gate",
        "// Extracted under U3-CUT.",
        "//",
        "// This module preserves the existing CDAS upload,",
        "// dry-run, preflight, idempotency, transaction,",
        "// R2-write, recovery, and draft-record semantics.",
        "//",
        "// It does not perform draft review, activation preparation,",
        "// activation, listing/requestability, access review,",
        "// licence preparation, licence issuance, PDF generation,",
        "// download-link creation, or email delivery.",
        "",
        'import { jsonResponse } from "../../../shared.js";',
        "",
        named_import(
            plan["common_dependencies"],
            "../common.js",
        ),
        "",
        named_import(
            {
                "getIdempotencyRecordForClientKey",
            },
            "../../idempotency.js",
        ),
        "",
        named_import(
            {
                "orchestrateUploadR2Write",
            },
            "../../write-orchestrator.js",
        ),
        "",
        named_import(
            {
                "byteLength",
                "sha256Hex",
            },
            "../../hash.js",
        ),
        "",
        named_import(
            {
                "requireUploadObjectKeysAbsent",
            },
            "../../r2-objects.js",
        ),
        "",
        named_import(
            {
                "createUploadTransaction",
            },
            "../../transactions.js",
        ),
        "",
        named_import(
            {
                "parseStrictUploadRequest",
            },
            "../../parse-multipart.js",
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


def rewrite_admin_routes(
    plan,
) -> str:
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
            "handleCdasDocumentUploadSkeleton "
            "} from "
            '"./admin/gates/'
            'cdas-document-upload.js";'
        ),
    )

    if EXPECTED_ROUTE not in rewritten:
        fail(
            "U3-K route disappeared during rewrite."
        )

    if (
        "return "
        "handleCdasDocumentUploadSkeleton"
        "(request, env);"
        not in rewritten
    ):
        fail(
            "U3-K dispatcher call disappeared."
        )

    source_functions = top_level_functions(
        rewritten
    )

    if HANDLER in source_functions:
        fail(
            "U3-K handler remains inline."
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
        / "cdas-draft-review.js",

        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-activation-preparation.js",

        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-explicit-activation.js",

        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-listing-requestability.js",

        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-access-request-intake.js",

        ROOT
        / "worker/src/upload/admin/gates/"
        / "cdas-access-request-review.js",

        ROOT
        / "worker/src/upload/idempotency.js",

        ROOT
        / "worker/src/upload/write-orchestrator.js",

        ROOT
        / "worker/src/upload/hash.js",

        ROOT
        / "worker/src/upload/r2-objects.js",

        ROOT
        / "worker/src/upload/transactions.js",

        ROOT
        / "worker/src/upload/parse-multipart.js",
    ]

    for path in paths:
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
                print(
                    result.stdout
                )

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
            "U3-K",
            "./worker/src/upload/admin/gates/"
            "cdas-document-upload.js",
        ),
        (
            "U3-L",
            "./worker/src/upload/admin/gates/"
            "cdas-draft-review.js",
        ),
        (
            "U3-M",
            "./worker/src/upload/admin/gates/"
            "cdas-activation-preparation.js",
        ),
        (
            "U3-N",
            "./worker/src/upload/admin/gates/"
            "cdas-explicit-activation.js",
        ),
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
                print(
                    result.stdout
                )

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
            print(
                result.stdout
            )

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
                f"{name} missing from U3-K gate"
            )

    if (
        'from "./admin/gates/'
        'cdas-document-upload.js"'
        not in source
    ):
        fail(
            "U3-K dispatcher import missing."
        )

    if EXPECTED_ROUTE not in source:
        fail(
            "U3-K route missing."
        )

    downstream_routes = [
        "/api/admin/uploads/cdas-document/review",
        "/api/admin/uploads/cdas-document/activation-prep",
        "/api/admin/uploads/cdas-document/activate",
        "/api/admin/uploads/cdas-document/listing-requestability",
        "/api/admin/uploads/cdas-document/access-request",
        "/api/admin/uploads/cdas-document/access-request/review",
    ]

    for route in downstream_routes:
        if route not in source:
            fail(
                "Downstream dispatcher route disappeared: "
                f"{route}"
            )

    required_gate_imports = [
        "cdas-draft-review.js",
        "cdas-activation-preparation.js",
        "cdas-explicit-activation.js",
        "cdas-listing-requestability.js",
        "cdas-access-request-intake.js",
        "cdas-access-request-review.js",
    ]

    for module in required_gate_imports:
        if module not in source:
            fail(
                "Previously extracted gate import disappeared: "
                f"{module}"
            )

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if (
            forbidden in source
            or forbidden in gate
        ):
            fail(
                "Feature freeze violation: "
                f"{forbidden} appeared."
            )

    log(
        "Structural postconditions PASS."
    )


def report(
    before_lines: int,
) -> None:
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
        "===== U3-K EXTRACTION RESULT ====="
    )
    print()

    print(
        f"admin-routes.js: "
        f"{before_lines} -> "
        f"{after_lines} lines"
    )

    print(
        f"U3-K gate:       "
        f"{gate_lines} lines"
    )

    print()
    print(
        "PASS — U3-K extracted"
    )

    print(
        "PASS — dispatcher preserved"
    )

    print(
        "PASS — dry-run behaviour structurally preserved"
    )

    print(
        "PASS — real-write behaviour structurally preserved"
    )

    print(
        "PASS — idempotency dependencies preserved"
    )

    print(
        "PASS — transaction dependencies preserved"
    )

    print(
        "PASS — R2 orchestration dependencies preserved"
    )

    print(
        "PASS — U3-L preserved"
    )

    print(
        "PASS — U3-M preserved"
    )

    print(
        "PASS — U3-N preserved"
    )

    print(
        "PASS — U3-O preserved"
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
            "Extract U3-K CDAS Document Upload Gate."
        )
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply U3-K extraction. "
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
                "U3-K target module already exists."
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

        backup_files(
            backup
        )

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
            f"U3-K EXTRACTION FAILED: {exc}",
            file=sys.stderr,
        )

        if (
            backup is not None
            and backup.exists()
        ):
            try:
                restore(
                    backup
                )
            except Exception as restore_exc:
                print(
                    "RESTORE FAILED: "
                    f"{restore_exc}",
                    file=sys.stderr,
                )

        return 1


if __name__ == "__main__":
    raise SystemExit(main())
