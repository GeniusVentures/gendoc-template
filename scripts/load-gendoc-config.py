"""
load-gendoc-config.py

MkDocs hook that reads gendoc.yml at startup and applies project-specific
configuration to the mkdocs config dict.  This keeps the template entirely
project-agnostic — every host project customises site_name, docs_dir, and
site_dir through its gendoc.yml file.

Registered in mkdocs.yml via:

    hooks:
      - scripts/load-gendoc-config.py
"""

import logging
import os
import re
import shutil
from pathlib import Path

import yaml

logger = logging.getLogger("mkdocs")


def on_config(config):
    """MkDocs hook entry point — called after config file is loaded.

    Reads gendoc.yml from the template root, resolves absolute paths
    relative to the host project root, and injects the runtime values
    into the mkdocs config dictionary.

    Returns the (possibly modified) config dict.
    """
    # Resolve paths relative to this script's location.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    template_root = os.path.dirname(script_dir)   # scripts/ → template root
    host_project_root = os.path.dirname(template_root)  # template/ → host project root

    # Look for gendoc.yml in the host project root (not in the submodule).
    # The submodule only contains gendoc.yml.example — the filled-out config
    # lives in the host project so the submodule stays read-only.
    gendoc_path = os.path.join(host_project_root, "gendoc.yml")

    if not os.path.isfile(gendoc_path):
        example_path = os.path.join(template_root, "gendoc.yml.example")
        logger.warning(
            "load_gendoc_config: %s not found. "
            "Copy %s to %s and edit for your project.",
            gendoc_path, example_path, gendoc_path,
        )
        return config

    try:
        with open(gendoc_path, "r") as f:
            cfg = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        logger.warning(
            "load_gendoc_config: failed to parse %s — %s", gendoc_path, exc
        )
        return config

    if not isinstance(cfg, dict):
        logger.warning(
            "load_gendoc_config: %s is not a valid config dictionary", gendoc_path
        )
        return config

    host_project_root = os.path.dirname(template_root)

    # ── Site name ──────────────────────────────────────────────────────────
    project_name = cfg.get("project", {}).get("name")
    if project_name:
        config["site_name"] = project_name
        logger.info("load_gendoc_config: site_name = %s", project_name)

    # ── Docs directory (resolved relative to host project root) ────────────
    docs_subdir = cfg.get("paths", {}).get("handwritten_docs")
    if docs_subdir:
        abs_docs = os.path.join(host_project_root, docs_subdir)
        abs_docs = os.path.abspath(abs_docs)
        config["docs_dir"] = abs_docs
        logger.info("load_gendoc_config: docs_dir = %s", abs_docs)

    # ── Generator (hide "Made with Material for MkDocs" footer) ────────────
    generator = cfg.get("project", {}).get("generator")
    if generator is False:
        config["extra"]["generator"] = False
        logger.info("load_gendoc_config: generator = false")

    # ── Logo (copy into docs_dir so MkDocs produces a relative <img src>) ──
    project_logo = cfg.get("project", {}).get("logo")
    if project_logo:
        abs_logo = os.path.join(host_project_root, project_logo)
        if os.path.isfile(abs_logo):
            dest = os.path.join(config["docs_dir"], os.path.basename(abs_logo))
            shutil.copy2(abs_logo, dest)
            config["theme"].logo = os.path.basename(abs_logo)
            config["theme"]["logo"] = os.path.basename(abs_logo)
            logger.info("load_gendoc_config: logo = %s (copied to docs_dir)", abs_logo)
        else:
            logger.warning("load_gendoc_config: logo not found at %s", abs_logo)

    # ── Site directory ─────────────────────────────────────────────────────
    # build.sh passes --site-dir with an absolute path; do NOT override it
    # here with the raw relative value from gendoc.yml, or on_post_build's
    # logo-path fix resolves against CWD instead of the real output directory.

    # Stash logo basename for post-build path fix
    config["_logo_basename"] = config["theme"].get("logo", "")

    # ── GitBook mode flag — enables rewrite_gitbook_paths.py hook ──────────
    nav_sections = cfg.get("navigation", {}).get("sections", [])
    config["gitbook_mode"] = any(s.get("gitbook") for s in nav_sections)
    if config["gitbook_mode"]:
        logger.info("load_gendoc_config: gitbook_mode = true")

    # ── Section-index plugin — disable when nav uses section-index=false ────
    if cfg.get("navigation", {}).get("section_index") is False:
        before = list(config["plugins"].keys())
        result = config["plugins"].pop("section-index", None)
        after = list(config["plugins"].keys())
        logger.info("load_gendoc_config: section_index pop result=%r, before=%s, after=%s",
                    result, before, after)
        logger.info("load_gendoc_config: section_index = false (plugin removed)")

    # ── navigation.indexes feature — disable when nav uses navigation_indexes=false
    if cfg.get("navigation", {}).get("navigation_indexes") is False:
        features = config["theme"]["features"]
        if "navigation.indexes" in features:
            features.remove("navigation.indexes")
            logger.info("load_gendoc_config: navigation_indexes = false (feature removed)")

    # ── navigation.sections feature — opt-in via gendoc.yml (default: accordion)
    if cfg.get("navigation", {}).get("navigation_sections") is True:
        features = config["theme"]["features"]
        if "navigation.sections" not in features:
            features.append("navigation.sections")
            logger.info("load_gendoc_config: navigation_sections = true (feature added)")

    # ── External docs plugin sources ──────────────────────────────────────
    # Inject external_docs.sources from gendoc.yml into the external-docs
    # plugin config so sources are managed in one place (gendoc.yml) rather
    # than duplicated in mkdocs.yml.
    ext_docs = cfg.get("external_docs", {})
    ext_sources = ext_docs.get("sources", [])
    if ext_sources:
        # Resolve paths relative to the host project root (where gendoc.yml lives).
        # Sources may be plain glob strings or dicts with label + paths.
        resolved = []
        for src in ext_sources:
            if isinstance(src, dict):
                paths = src.get("paths", [])
            else:
                paths = [src]
            for pattern in paths:
                resolved.append(os.path.join(host_project_root, pattern))
        # Find the external-docs plugin and update its sources.
        # Use clear+extend in-place to ensure the list reference is shared
        # with the plugin instance (direct assignment may not propagate).
        for plugin in config["plugins"]:
            if hasattr(plugin, "config") and "sources" in plugin.config:
                existing = plugin.config["sources"]
                existing.clear()
                existing.extend(resolved)
                logger.info(
                    "load_gendoc_config: external_docs sources injected (%d patterns)",
                    len(resolved),
                )
                break

    return config


def on_post_build(config):
    """Replace absolute logo paths in built HTML with relative basename."""
    logo = config.get("_logo_basename", "")
    if not logo:
        return
    site_dir = config["site_dir"]
    count = 0
    for html_file in Path(site_dir).rglob("*.html"):
        content = html_file.read_text()
        updated = re.sub(r'src="[^"]*' + re.escape(logo) + r'"',
                         f'src="/{logo}"', content)
        if updated != content:
            html_file.write_text(updated)
            count += 1
    if count:
        logger.info("load_gendoc_config: fixed logo src in %d files", count)

