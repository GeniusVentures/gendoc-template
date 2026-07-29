"""
MkDocs plugin that adds Markdown files from outside the docs directory into the
build. Configure with glob patterns relative to the project root (where
mkdocs.yml lives) or with absolute paths injected from gendoc.yml.

Example:

    plugins:
      - external-docs:
          sources:
            - "../../SuperGenius/evmrelay/docs/rlpx/**/*.md"
            - "../../SuperGenius/evmrelay/.planning/codebase/ARCHITECTURE.md"

Files inside the project root retain their relative path. Files outside the
project root are published at the documentation root using their filename.
This allows a documentation submodule to expose a parent-repository Markdown
file such as ../MASTER_ARCHITECTURE.md without copying it.

Works with both MkDocs and ProperDocs. Compatible with MkDocs >= 1.4.
"""

from __future__ import annotations

import glob as glob_mod
from pathlib import Path, PurePath
from typing import Any, Dict, List

from mkdocs.config import config_options
from mkdocs.plugins import BasePlugin
from mkdocs.structure.files import File, Files, InclusionLevel


class ExternalDocsPlugin(BasePlugin):
    config_scheme = (
        ("sources", config_options.Type(list, default=[])),
    )

    def on_config(self, config: Dict[str, Any]) -> Dict[str, Any] | None:
        cfg_path = Path(config.get("config_file_path", ""))
        if not cfg_path.is_file():
            return config
        self._project_root = cfg_path.parent.resolve()

        # Expand globs now so errors surface before the build runs. Absolute
        # patterns are accepted because load-gendoc-config.py resolves paths
        # relative to the host repository before injecting them here.
        resolved: List[Path] = []
        for pattern in self.config["sources"]:
            pattern_path = Path(pattern)
            abs_pattern = str(
                pattern_path
                if pattern_path.is_absolute()
                else self._project_root / pattern_path
            )
            matches = glob_mod.glob(abs_pattern, recursive=True)
            if not matches:
                print(f"[external-docs] WARNING: no files matched '{pattern}'")
            for match in sorted(matches):
                path = Path(match).resolve()
                if path.suffix in (".md", ".markdown"):
                    resolved.append(path)
        self._files_to_add = resolved
        return config

    def on_files(self, files: Files, /, *, config: Dict[str, Any]) -> Files | None:
        use_dir_urls = config.get("use_directory_urls", True)
        dest_dir = config.get("site_dir", "site")

        for fpath in self._files_to_add:
            # Preserve project-relative paths when possible. A genuine external
            # file cannot be represented with Path.relative_to(), so publish it
            # at the documentation root by filename instead of failing the build.
            try:
                rel_path = fpath.relative_to(self._project_root)
            except ValueError:
                rel_path = Path(fpath.name)

            parts = [part for part in PurePath(rel_path).parts if part != ".."]
            src_uri = "/".join(parts)

            file = File(
                path=src_uri,
                src_dir=None,
                dest_dir=dest_dir,
                use_directory_urls=use_dir_urls,
                inclusion=InclusionLevel.INCLUDED,
            )
            # Point abs_src_path at the real file on disk (must be set directly
            # because the cached_property uses src_dir, which is intentionally None).
            file.abs_src_path = str(fpath)
            file.generated_by = "external-docs"
            files.append(file)
            print(
                f"[external-docs] added {fpath} -> {file.dest_uri} "
                f"(url: {file.url})"
            )

        return files
