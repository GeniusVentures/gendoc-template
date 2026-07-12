"""
MkDocs plugin that adds markdown files from outside the docs directory into the
build.  Configure with glob patterns relative to the project root (where
mkdocs.yml lives).

    plugins:
      - external-docs:
          sources:
            - "../../SuperGenius/evmrelay/docs/rlpx/**/*.md"
            - "../../SuperGenius/evmrelay/.planning/codebase/ARCHITECTURE.md"

Works with both MkDocs and ProperDocs.  Compatible with MkDocs >= 1.4.
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

        # Expand globs now so errors surface before the build runs.
        resolved: List[Path] = []
        for pattern in self.config["sources"]:
            abs_pattern = str(self._project_root / pattern)
            matches = glob_mod.glob(abs_pattern, recursive=True)
            if not matches:
                print(f"[external-docs] WARNING: no files matched '{pattern}'")
            for m in sorted(matches):
                p = Path(m)
                if p.suffix in (".md", ".markdown"):
                    resolved.append(p)
        self._files_to_add = resolved
        return config

    def on_files(self, files: Files, /, *, config: Dict[str, Any]) -> Files | None:
        use_dir_urls = config.get("use_directory_urls", True)
        dest_dir = config.get("site_dir", "site")

        for fpath in self._files_to_add:
            # Build a synthetic src_uri that encodes the desired output path.
            # Strip leading ".." segments from the path relative to the project
            # root so URLs are clean.  MkDocs computes dest_uri and url from
            # src_uri — we let it do that work.
            rel = str(fpath.relative_to(self._project_root))
            parts = [p for p in PurePath(rel).parts if p != ".."]
            src_uri = "/".join(parts)

            f = File(
                path=src_uri,
                src_dir=None,
                dest_dir=dest_dir,
                use_directory_urls=use_dir_urls,
                inclusion=InclusionLevel.INCLUDED,
            )
            # Point abs_src_path at the real file on disk (must be set directly
            # because the cached_property uses src_dir which we left as None).
            f.abs_src_path = str(fpath)
            f.generated_by = "external-docs"
            files.append(f)
            print(f"[external-docs] added {rel}  →  {f.dest_uri}  (url: {f.url})")

        return files
