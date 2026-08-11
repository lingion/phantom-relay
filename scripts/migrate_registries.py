#!/usr/bin/env python3
"""Create separated registry documents from Phantom Relay legacy config.

The command is additive: it reads legacy files and writes new documents into a
separate output directory. It never edits model_routes.json or selector_templates.json.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from server.registry import build_migration_documents


def read_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def build_documents(model_routes: Path, selector_templates: Path) -> dict:
    legacy_models = read_json(model_routes)
    legacy_templates = read_json(selector_templates) if selector_templates.exists() else {}
    return build_migration_documents(legacy_models, legacy_templates)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-routes", type=Path, required=True)
    parser.add_argument("--selector-templates", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)

    documents = build_documents(args.model_routes, args.selector_templates)
    write_json_atomic(args.output_dir / "model_registry.json", documents["model_registry"])
    write_json_atomic(args.output_dir / "profile_registry.json", documents["profile_registry"])
    write_json_atomic(args.output_dir / "user_bindings.json", documents["user_bindings"])
    write_json_atomic(args.output_dir / "migration_report.json", {"hints": documents["migration_hints"]})
    print(json.dumps({
        "output_dir": str(args.output_dir),
        "model_count": len(documents["model_registry"]["models"]),
        "profile_count": len(documents["profile_registry"]["profiles"]),
        "binding_count": len(documents["user_bindings"]["bindings"]),
        "hint_count": len(documents["migration_hints"]),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
