#!/usr/bin/env python3

"""
U3-CUT — dependency-aware CDAS Upload Admin refactor.

Stage 1:
  - extract U3-Q Controlled Access Request Review Gate;
  - calculate its top-level function dependency closure;
  - move shared dependencies into admin/common.js;
  - preserve existing dispatcher route and behaviour;
  - do NOT implement U3-R;
  - validate syntax and git diff;
  - restore original files automatically on failure.

Dry run is the default.
Use --apply only after reviewing the dependency plan.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import subprocess
import sys

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


# ============================================================================
# Paths
# ============================================================================

ROOT = Path(__file__).resolve().parents[1]

SOURCE = ROOT / "worker/src/upload/admin-routes.js"

COMMON = (
    ROOT
    / "worker/src/upload/admin/common.js"
)

GATE = (
    ROOT
    / "worker/src/upload/admin/gates/"
    / "cdas-access-request-review.js"
)

BACKUP_ROOT = ROOT / ".refactor-backups"


# ============================================================================
# U3-Q / feature-freeze definition
# ============================================================================

U3Q_HANDLER = "handleCdasControlledAccessRequestReview"

U3Q_SEED_FUNCTIONS = {
    "handleCdasControlledAccessRequestReview",
    "buildDocumentAccessRequestReviewEventId",
    "normaliseAccessRequestReviewAction",
    "validateAccessRequestReviewAction",
    "buildAccessRequestReviewOutcome",
    "getDocumentAccessRequestForControlledReview",
    "getDocumentForAccessRequestReview",
    "validateDocumentStillEligibleForApproval",
    "updateDocumentAccessRequestReviewState",
    "insertDocumentAccessRequestReviewEvent",
}

U3Q_SEED_CONSTANTS = {
    "VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS",
}

EXPECTED_ROUTE = (
    "/api/admin/uploads/cdas-document/"
    "access-request/review"
)

EXPECTED_NEXT_GATE_MARKER = (
    "U3-R — CDAS Licence Preparation Gate"
)

FORBIDDEN_U3R_HANDLERS = {
    "handleCdasLicencePreparation",
    "handleCdasLicensePreparation",
}


# ============================================================================
# Errors / data structures
# ============================================================================

class RefactorError(RuntimeError):
    pass


@dataclass(frozen=True)
class Block:
    name: str
    start: int
    end: int
    text: str
    kind: str


@dataclass
class Plan:
    source: str
    functions: dict[str, Block]
    consts: dict[str, Block]
    imports: dict[str, str]

    closure: set[str]

    gate_functions: set[str]
    common_functions: set[str]
    gate_constants: set[str]

    external_import_statements: list[str]


# ============================================================================
# Logging / utilities
# ============================================================================

def log(message: str) -> None:
    print(f"[U3-CUT] {message}")


def die(message: str) -> None:
    raise RefactorError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(
        path.read_bytes()
    ).hexdigest()


def run(
    command: list[str],
    *,
    check: bool = False,
) -> subprocess.CompletedProcess:
    log("$ " + " ".join(command))

    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=check,
    )


# ============================================================================
# Structural JavaScript scanning
# ============================================================================

def matching_brace(
    text: str,
    opening: int,
) -> int:
    """
    Return the closing brace matching text[opening] == '{'.

    Handles:
      - quoted strings
      - template literals
      - escaped characters
      - // comments
      - /* comments */

    This is deliberately a structural scanner rather than a JavaScript AST
    parser. It exists only to make deterministic movement of existing
    top-level declarations possible.
    """

    if (
        opening >= len(text)
        or text[opening] != "{"
    ):
        die(
            f"Expected '{{' at offset "
            f"{opening}"
        )

    depth = 0
    i = opening

    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False

    while i < len(text):
        ch = text[i]

        nxt = (
            text[i + 1]
            if i + 1 < len(text)
            else ""
        )

        if line_comment:
            if ch == "\n":
                line_comment = False

            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue

            i += 1
            continue

        if quote is not None:
            if escaped:
                escaped = False
                i += 1
                continue

            if ch == "\\":
                escaped = True
                i += 1
                continue

            if ch == quote:
                quote = None

            i += 1
            continue

        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            continue

        if ch == "{":
            depth += 1

        elif ch == "}":
            depth -= 1

            if depth == 0:
                return i

        i += 1

    die(
        "Could not find matching "
        "closing brace."
    )

    raise AssertionError


def matching_paren(
    text: str,
    opening: int,
) -> int:
    """
    Return the closing parenthesis matching text[opening] == '('.

    This is critical for multiline JavaScript function declarations with
    default parameters such as:

        async function example(
          env,
          options = {}
        ) {

    We must skip the entire parameter list before locating the function body's
    opening brace.
    """

    if (
        opening >= len(text)
        or text[opening] != "("
    ):
        die(
            f"Expected '(' at offset "
            f"{opening}"
        )

    depth = 0
    i = opening

    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False

    while i < len(text):
        ch = text[i]

        nxt = (
            text[i + 1]
            if i + 1 < len(text)
            else ""
        )

        if line_comment:
            if ch == "\n":
                line_comment = False

            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue

            i += 1
            continue

        if quote is not None:
            if escaped:
                escaped = False
                i += 1
                continue

            if ch == "\\":
                escaped = True
                i += 1
                continue

            if ch == quote:
                quote = None

            i += 1
            continue

        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            continue

        if ch == "(":
            depth += 1

        elif ch == ")":
            depth -= 1

            if depth == 0:
                return i

        i += 1

    die(
        "Could not find matching "
        "closing parenthesis."
    )

    raise AssertionError


def statement_end(
    text: str,
    start: int,
) -> int:
    """
    Find the top-level terminating semicolon for a const declaration.
    """

    i = start

    quote: str | None = None
    escaped = False

    line_comment = False
    block_comment = False

    braces = 0
    brackets = 0
    parens = 0

    while i < len(text):
        ch = text[i]

        nxt = (
            text[i + 1]
            if i + 1 < len(text)
            else ""
        )

        if line_comment:
            if ch == "\n":
                line_comment = False

            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue

            i += 1
            continue

        if quote is not None:
            if escaped:
                escaped = False
                i += 1
                continue

            if ch == "\\":
                escaped = True
                i += 1
                continue

            if ch == quote:
                quote = None

            i += 1
            continue

        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            continue

        if ch == "{":
            braces += 1

        elif ch == "}":
            braces -= 1

        elif ch == "[":
            brackets += 1

        elif ch == "]":
            brackets -= 1

        elif ch == "(":
            parens += 1

        elif ch == ")":
            parens -= 1

        elif (
            ch == ";"
            and braces == 0
            and brackets == 0
            and parens == 0
        ):
            return i

        i += 1

    die(
        "Could not locate statement "
        "terminator."
    )

    raise AssertionError


def consume_line_end(
    text: str,
    end: int,
) -> int:
    """
    Consume trailing horizontal whitespace and one newline.
    """

    while (
        end < len(text)
        and text[end] in " \t"
    ):
        end += 1

    if (
        end < len(text)
        and text[end] == "\r"
    ):
        end += 1

    if (
        end < len(text)
        and text[end] == "\n"
    ):
        end += 1

    return end


def find_function(
    text: str,
    name: str,
) -> Block | None:
    """
    Find a top-level named function declaration.

    Important:
    The opening function-body brace is located only after the entire parameter
    list has been structurally scanned. This prevents default parameters such
    as options = {} from being mistaken for the function body.
    """

    pattern = re.compile(
        rf"(?m)^[ \t]*"
        rf"(?:export[ \t]+)?"
        rf"(?:async[ \t]+)?"
        rf"function[ \t]+"
        rf"{re.escape(name)}"
        rf"[ \t]*\("
    )

    match = pattern.search(text)

    if not match:
        return None

    paren_open = text.rfind(
        "(",
        match.start(),
        match.end(),
    )

    if paren_open < 0:
        die(
            f"No parameter opening "
            f"parenthesis found for {name}"
        )

    paren_close = matching_paren(
        text,
        paren_open,
    )

    opening = text.find(
        "{",
        paren_close + 1,
    )

    if opening < 0:
        die(
            f"No function body opening "
            f"brace found for {name}"
        )

    closing = matching_brace(
        text,
        opening,
    )

    end = consume_line_end(
        text,
        closing + 1,
    )

    return Block(
        name=name,
        start=match.start(),
        end=end,
        text=text[
            match.start():end
        ],
        kind="function",
    )


def find_const(
    text: str,
    name: str,
) -> Block | None:
    pattern = re.compile(
        rf"(?m)^[ \t]*"
        rf"(?:export[ \t]+)?"
        rf"const[ \t]+"
        rf"{re.escape(name)}"
        rf"[ \t]*="
    )

    match = pattern.search(text)

    if not match:
        return None

    semi = statement_end(
        text,
        match.start(),
    )

    end = consume_line_end(
        text,
        semi + 1,
    )

    return Block(
        name=name,
        start=match.start(),
        end=end,
        text=text[
            match.start():end
        ],
        kind="const",
    )


def top_level_functions(
    text: str,
) -> dict[str, Block]:
    names = re.findall(
        r"(?m)^[ \t]*"
        r"(?:export[ \t]+)?"
        r"(?:async[ \t]+)?"
        r"function[ \t]+"
        r"([A-Za-z_$][\w$]*)"
        r"[ \t]*\(",
        text,
    )

    result: dict[str, Block] = {}

    for name in names:
        block = find_function(
            text,
            name,
        )

        if block:
            result[name] = block

    return result


def top_level_consts(
    text: str,
) -> dict[str, Block]:
    names = re.findall(
        r"(?m)^[ \t]*"
        r"(?:export[ \t]+)?"
        r"const[ \t]+"
        r"([A-Za-z_$][\w$]*)"
        r"[ \t]*=",
        text,
    )

    result: dict[str, Block] = {}

    for name in names:
        block = find_const(
            text,
            name,
        )

        if block:
            result[name] = block

    return result


# ============================================================================
# Import parsing
# ============================================================================

def parse_imports(
    text: str,
) -> dict[str, str]:
    """
    Return:

        local_symbol -> complete import statement
    """

    result: dict[str, str] = {}

    pattern = re.compile(
        r"(?ms)^[ \t]*"
        r"import[ \t]+"
        r"(.*?)"
        r"[ \t]+from[ \t]+"
        r"([\"'].*?[\"'])"
        r"[ \t]*;"
    )

    for match in pattern.finditer(text):
        clause = match.group(1).strip()
        statement = match.group(0).strip()

        named = re.search(
            r"\{(.*?)\}",
            clause,
            re.S,
        )

        if named:
            for part in named.group(1).split(","):
                part = part.strip()

                if not part:
                    continue

                if " as " in part:
                    _, local = re.split(
                        r"\s+as\s+",
                        part,
                        maxsplit=1,
                    )

                    symbol = local.strip()

                else:
                    symbol = part

                result[symbol] = statement

        default = clause.split(
            ",",
            1,
        )[0].strip()

        if (
            default
            and not default.startswith(
                ("{", "*")
            )
        ):
            result[default] = statement

    return result


def unique(
    values: list[str],
) -> list[str]:
    seen = set()
    output = []

    for value in values:
        if value in seen:
            continue

        seen.add(value)
        output.append(value)

    return output


# ============================================================================
# Dependency analysis
# ============================================================================

CALL_RE = re.compile(
    r"(?<![\w.$])"
    r"([A-Za-z_$][\w$]*)"
    r"[ \t]*\("
)


def called_identifiers(
    block: Block,
) -> set[str]:
    """
    Return identifiers that syntactically look like direct calls:

        foo(...)

    Method calls such as:

        env.DB.prepare(...)

    are intentionally excluded because they are not top-level function
    dependencies.
    """

    return set(
        CALL_RE.findall(
            block.text
        )
    )


def dependency_closure(
    functions: dict[str, Block],
    seed_functions: set[str],
) -> set[str]:
    """
    Recursively follow direct calls from U3-Q into locally declared top-level
    functions.
    """

    closure = set(
        seed_functions
    )

    queue = list(
        seed_functions
    )

    while queue:
        current = queue.pop()

        block = functions.get(
            current
        )

        if not block:
            die(
                f"Dependency seed "
                f"function missing: {current}"
            )

        for called in called_identifiers(
            block
        ):
            if called not in functions:
                continue

            if called in closure:
                continue

            closure.add(
                called
            )

            queue.append(
                called
            )

    return closure


def remove_blocks(
    text: str,
    blocks: list[Block],
) -> str:
    result = text

    unique_blocks = {
        (
            block.start,
            block.end,
        ): block
        for block in blocks
    }.values()

    for block in sorted(
        unique_blocks,
        key=lambda item: item.start,
        reverse=True,
    ):
        result = (
            result[:block.start]
            + result[block.end:]
        )

    result = re.sub(
        r"\n{4,}",
        "\n\n\n",
        result,
    )

    return result


def remaining_reference_exists(
    source: str,
    blocks_removed: list[Block],
    name: str,
) -> bool:
    """
    Return True if code outside the U3-Q extraction still references name.
    """

    remaining = remove_blocks(
        source,
        blocks_removed,
    )

    return bool(
        re.search(
            rf"\b{re.escape(name)}\b",
            remaining,
        )
    )


# ============================================================================
# Export/import generation
# ============================================================================

def make_exported(
    block: Block,
) -> str:
    text = block.text

    if re.match(
        r"(?m)^[ \t]*export\b",
        text,
    ):
        return text.rstrip()

    if block.kind == "function":
        changed, count = re.subn(
            r"(?m)^([ \t]*)"
            r"((?:async[ \t]+)?"
            r"function\b)",
            r"\1export \2",
            text,
            count=1,
        )

    else:
        changed, count = re.subn(
            r"(?m)^([ \t]*)"
            r"(const\b)",
            r"\1export \2",
            text,
            count=1,
        )

    if count != 1:
        die(
            f"Could not export "
            f"{block.name}"
        )

    return changed.rstrip()


def insertion_after_imports(
    text: str,
) -> int:
    matches = list(
        re.finditer(
            r"(?ms)^[ \t]*"
            r"import\b.*?;"
            r"[ \t]*(?:\r?\n)?",
            text,
        )
    )

    if not matches:
        return 0

    return matches[-1].end()


def add_import(
    text: str,
    statement: str,
) -> str:
    if statement in text:
        return text

    position = insertion_after_imports(
        text
    )

    if position == 0:
        return (
            statement
            + "\n\n"
            + text
        )

    return (
        text[:position].rstrip()
        + "\n"
        + statement
        + "\n\n"
        + text[position:].lstrip("\n")
    )


def named_import(
    symbols: list[str],
    path: str,
) -> str:
    symbols = sorted(
        symbols
    )

    if len(symbols) == 1:
        return (
            f'import {{ {symbols[0]} }} '
            f'from "{path}";'
        )

    return (
        "import {\n"
        + "".join(
            f"  {name},\n"
            for name in symbols
        )
        + f'}} from "{path}";'
    )


# ============================================================================
# Dependency plan
# ============================================================================

def build_plan(
    source: str,
) -> Plan:
    functions = top_level_functions(
        source
    )

    consts = top_level_consts(
        source
    )

    imports = parse_imports(
        source
    )

    # ------------------------------------------------------------------
    # Feature freeze
    # ------------------------------------------------------------------

    for forbidden in FORBIDDEN_U3R_HANDLERS:
        if forbidden in functions:
            die(
                "Feature-freeze violation: "
                f"{forbidden} exists. "
                "U3-R implementation status must be "
                "reviewed before refactoring."
            )

    if EXPECTED_NEXT_GATE_MARKER not in source:
        die(
            "Expected U3-R next-gate "
            "marker is missing."
        )

    if EXPECTED_ROUTE not in source:
        die(
            "Expected U3-Q route "
            "path is missing."
        )

    # ------------------------------------------------------------------
    # Required seeds
    # ------------------------------------------------------------------

    for name in U3Q_SEED_FUNCTIONS:
        if name not in functions:
            die(
                f"Required U3-Q "
                f"function missing: {name}"
            )

    for name in U3Q_SEED_CONSTANTS:
        if name not in consts:
            die(
                f"Required U3-Q "
                f"constant missing: {name}"
            )

    # ------------------------------------------------------------------
    # Dependency closure
    # ------------------------------------------------------------------

    closure = dependency_closure(
        functions,
        U3Q_SEED_FUNCTIONS,
    )

    seed_blocks = [
        functions[name]
        for name in U3Q_SEED_FUNCTIONS
    ]

    common_functions: set[str] = set()

    for name in (
        closure
        - U3Q_SEED_FUNCTIONS
    ):
        if remaining_reference_exists(
            source,
            seed_blocks,
            name,
        ):
            common_functions.add(
                name
            )

    gate_functions = (
        closure
        - common_functions
    )

    gate_functions |= (
        U3Q_SEED_FUNCTIONS
    )

    gate_constants = set(
        U3Q_SEED_CONSTANTS
    )

    # ------------------------------------------------------------------
    # External imports required by the extracted closure
    # ------------------------------------------------------------------

    used_blocks = (
        [
            functions[name]
            for name in gate_functions
        ]
        + [
            functions[name]
            for name in common_functions
        ]
        + [
            consts[name]
            for name in gate_constants
        ]
    )

    external_import_statements: list[str] = []

    for block in used_blocks:
        for called in called_identifiers(
            block
        ):
            statement = imports.get(
                called
            )

            if statement:
                external_import_statements.append(
                    statement
                )

    external_import_statements = unique(
        external_import_statements
    )

    return Plan(
        source=source,
        functions=functions,
        consts=consts,
        imports=imports,
        closure=closure,
        gate_functions=gate_functions,
        common_functions=common_functions,
        gate_constants=gate_constants,
        external_import_statements=external_import_statements,
    )


def print_plan(
    plan: Plan,
) -> None:
    print()
    print(
        "===== U3-CUT DEPENDENCY PLAN ====="
    )
    print()

    print(
        "U3-Q gate functions:"
    )

    for name in sorted(
        plan.gate_functions
    ):
        print(
            f"  MOVE -> gate      "
            f"{name}"
        )

    print()
    print(
        "Shared dependency functions:"
    )

    if plan.common_functions:
        for name in sorted(
            plan.common_functions
        ):
            print(
                f"  MOVE -> common    "
                f"{name}"
            )

    else:
        print(
            "  none"
        )

    print()
    print(
        "U3-Q constants:"
    )

    for name in sorted(
        plan.gate_constants
    ):
        print(
            f"  MOVE -> gate      "
            f"{name}"
        )

    print()
    print(
        "External imports required:"
    )

    if plan.external_import_statements:
        for statement in (
            plan.external_import_statements
        ):
            indented = statement.replace(
                "\n",
                "\n  ",
            )

            print(
                "  " + indented
            )

    else:
        print(
            "  none"
        )

    print()
    print(
        "Feature freeze:"
    )

    print(
        "  U3-R handler: NOT PRESENT"
    )

    print(
        "  U3-R next-gate label: PRESENT"
    )

    print(
        "  U3-S: remains deferred"
    )

    print()


# ============================================================================
# Import path rewriting
# ============================================================================

def rewrite_import_for_common(
    statement: str,
) -> str:
    """
    Convert an import path from:

        worker/src/upload/admin-routes.js

    to:

        worker/src/upload/admin/common.js
    """

    statement = statement.replace(
        'from "../shared.js"',
        'from "../../shared.js"',
    )

    statement = statement.replace(
        "from '../shared.js'",
        "from '../../shared.js'",
    )

    statement = statement.replace(
        'from "./',
        'from "../',
    )

    statement = statement.replace(
        "from './",
        "from '../",
    )

    return statement


def rewrite_import_for_gate(
    statement: str,
) -> str:
    """
    Convert an import path from:

        worker/src/upload/admin-routes.js

    to:

        worker/src/upload/admin/gates/cdas-access-request-review.js
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


# ============================================================================
# Module generation
# ============================================================================

def build_common_module(
    plan: Plan,
) -> str:
    parts = [
        "// U3-CUT shared admin route dependencies.",
        "// Mechanically extracted from admin-routes.js.",
        "// No business behaviour is intentionally changed.",
        "",
    ]

    common_blocks = [
        plan.functions[name]
        for name in plan.common_functions
    ]

    external_imports = []

    for block in common_blocks:
        for called in called_identifiers(
            block
        ):
            statement = plan.imports.get(
                called
            )

            if statement:
                external_imports.append(
                    rewrite_import_for_common(
                        statement
                    )
                )

    external_imports = unique(
        external_imports
    )

    for statement in external_imports:
        parts.append(
            statement
        )

    if external_imports:
        parts.append(
            ""
        )

    for name in sorted(
        plan.common_functions,
        key=lambda item: (
            plan.functions[item].start
        ),
    ):
        parts.append(
            make_exported(
                plan.functions[name]
            )
        )

        parts.append(
            ""
        )

    return (
        "\n".join(parts).rstrip()
        + "\n"
    )


def build_gate_module(
    plan: Plan,
) -> str:
    parts = [
        "// U3-Q — CDAS Controlled Access Request Review Gate",
        "// Extracted under U3-CUT.",
        "// This module does NOT implement U3-R licence preparation.",
        "",
    ]

    gate_blocks = (
        [
            plan.functions[name]
            for name in plan.gate_functions
        ]
        + [
            plan.consts[name]
            for name in plan.gate_constants
        ]
    )

    external_imports = []

    for block in gate_blocks:
        for called in called_identifiers(
            block
        ):
            statement = plan.imports.get(
                called
            )

            if statement:
                external_imports.append(
                    rewrite_import_for_gate(
                        statement
                    )
                )

    external_imports = unique(
        external_imports
    )

    for statement in external_imports:
        parts.append(
            statement
        )

    if external_imports:
        parts.append(
            ""
        )

    if plan.common_functions:
        parts.append(
            named_import(
                list(
                    plan.common_functions
                ),
                "../common.js",
            )
        )

        parts.append(
            ""
        )

    for name in sorted(
        plan.gate_constants,
        key=lambda item: (
            plan.consts[item].start
        ),
    ):
        parts.append(
            plan.consts[name].text.rstrip()
        )

        parts.append(
            ""
        )

    for name in sorted(
        plan.gate_functions,
        key=lambda item: (
            plan.functions[item].start
        ),
    ):
        block = plan.functions[name]

        if name == U3Q_HANDLER:
            parts.append(
                make_exported(
                    block
                )
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


def rewrite_admin_routes(
    plan: Plan,
) -> str:
    blocks_to_remove = (
        [
            plan.functions[name]
            for name in plan.gate_functions
        ]
        + [
            plan.functions[name]
            for name in plan.common_functions
        ]
        + [
            plan.consts[name]
            for name in plan.gate_constants
        ]
    )

    rewritten = remove_blocks(
        plan.source,
        blocks_to_remove,
    )

    if plan.common_functions:
        rewritten = add_import(
            rewritten,
            named_import(
                list(
                    plan.common_functions
                ),
                "./admin/common.js",
            ),
        )

    rewritten = add_import(
        rewritten,
        (
            "import { "
            "handleCdasControlledAccessRequestReview "
            "} from "
            '"./admin/gates/'
            'cdas-access-request-review.js";'
        ),
    )

    if (
        'pathname === '
        '"/api/admin/uploads/cdas-document/'
        'access-request/review"'
        not in rewritten
    ):
        die(
            "U3-Q dispatcher route "
            "disappeared during rewrite."
        )

    if (
        "return "
        "handleCdasControlledAccessRequestReview"
        "(request, env);"
        not in rewritten
    ):
        die(
            "U3-Q dispatcher call "
            "disappeared during rewrite."
        )

    if find_function(
        rewritten,
        U3Q_HANDLER,
    ):
        die(
            "U3-Q handler remains "
            "inline after rewrite."
        )

    return rewritten


# ============================================================================
# Backup / rollback
# ============================================================================

def backup_dir() -> Path:
    return (
        BACKUP_ROOT
        / (
            "cdas-u3-cut-"
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
        COMMON,
        GATE,
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
        "Restoring pre-refactor files."
    )

    source_backup = (
        directory
        / SOURCE.relative_to(ROOT)
    )

    if source_backup.exists():
        SOURCE.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        shutil.copy2(
            source_backup,
            SOURCE,
        )

    for generated in [
        COMMON,
        GATE,
    ]:
        original = (
            directory
            / generated.relative_to(ROOT)
        )

        if original.exists():
            generated.parent.mkdir(
                parents=True,
                exist_ok=True,
            )

            shutil.copy2(
                original,
                generated,
            )

        elif generated.exists():
            generated.unlink()

    log(
        "Restore complete."
    )


# ============================================================================
# Validation
# ============================================================================

def validate() -> None:
    paths = [
        SOURCE,
        GATE,
    ]

    if COMMON.exists():
        paths.append(
            COMMON
        )

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

            die(
                "node --check failed: "
                f"{path.relative_to(ROOT)}"
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

        die(
            "git diff --check failed."
        )

    log(
        "Syntax and diff validation PASS."
    )


def postconditions() -> None:
    source = SOURCE.read_text(
        encoding="utf-8"
    )

    gate = GATE.read_text(
        encoding="utf-8"
    )

    if find_function(
        source,
        U3Q_HANDLER,
    ):
        die(
            "Postcondition failed: "
            "U3-Q handler still inline."
        )

    if not find_function(
        gate,
        U3Q_HANDLER,
    ):
        die(
            "Postcondition failed: "
            "U3-Q handler absent from gate module."
        )

    for forbidden in (
        FORBIDDEN_U3R_HANDLERS
    ):
        if (
            forbidden in source
            or forbidden in gate
        ):
            die(
                "Postcondition failed: "
                "prohibited U3-R handler "
                f"{forbidden} appeared "
                "during refactor."
            )

    if EXPECTED_ROUTE not in source:
        die(
            "Postcondition failed: "
            "U3-Q dispatcher route missing."
        )

    if EXPECTED_NEXT_GATE_MARKER not in gate:
        die(
            "Postcondition failed: "
            "U3-R next-gate marker was lost "
            "from extracted U3-Q behaviour."
        )

    log(
        "Structural postconditions PASS."
    )


# ============================================================================
# Reporting
# ============================================================================

def report(
    before_lines: int,
) -> None:
    source_lines = len(
        SOURCE.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    gate_lines = len(
        GATE.read_text(
            encoding="utf-8"
        ).splitlines()
    )

    print()
    print(
        "===== U3-CUT RESULT ====="
    )

    print(
        "admin-routes.js: "
        f"{before_lines} -> "
        f"{source_lines} lines"
    )

    print(
        "U3-Q gate:       "
        f"{gate_lines} lines"
    )

    if COMMON.exists():
        common_lines = len(
            COMMON.read_text(
                encoding="utf-8"
            ).splitlines()
        )

        print(
            "admin/common.js: "
            f"{common_lines} lines"
        )

    print()

    print(
        "PASS — U3-Q extracted"
    )

    print(
        "PASS — dispatcher preserved"
    )

    print(
        "PASS — JavaScript syntax"
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


# ============================================================================
# Main
# ============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Dependency-aware U3-CUT "
            "CDAS admin route refactor."
        )
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply the dependency-aware "
            "refactor. Default is dry run."
        ),
    )

    args = parser.parse_args()

    directory: Path | None = None

    try:
        if not SOURCE.exists():
            die(
                f"Missing source: {SOURCE}"
            )

        source = SOURCE.read_text(
            encoding="utf-8"
        )

        before_lines = len(
            source.splitlines()
        )

        log(
            f"Source SHA-256: "
            f"{sha256(SOURCE)}"
        )

        plan = build_plan(
            source
        )

        print_plan(
            plan
        )

        if not args.apply:
            log(
                "DRY RUN ONLY — "
                "no files changed."
            )

            log(
                "Review the dependency plan "
                "before using --apply."
            )

            return 0

        if COMMON.exists():
            die(
                f"{COMMON.relative_to(ROOT)} "
                "already exists. "
                "Refusing to overwrite it."
            )

        if GATE.exists():
            die(
                f"{GATE.relative_to(ROOT)} "
                "already exists. "
                "Refusing to overwrite it."
            )

        directory = backup_dir()

        directory.mkdir(
            parents=True,
            exist_ok=False,
        )

        backup_files(
            directory
        )

        COMMON.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        GATE.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        common_text = build_common_module(
            plan
        )

        gate_text = build_gate_module(
            plan
        )

        source_text = rewrite_admin_routes(
            plan
        )

        if plan.common_functions:
            COMMON.write_text(
                common_text,
                encoding="utf-8",
            )

        GATE.write_text(
            gate_text,
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
            f"Backup retained at "
            f"{directory}"
        )

        return 0

    except RefactorError as exc:
        print()

        print(
            f"U3-CUT FAILED: {exc}",
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