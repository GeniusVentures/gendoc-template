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
import shutil

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

    # ── Logo ────────────────────────────────────────────────────────────
    project_logo = cfg.get("project", {}).get("logo")
    if project_logo:
        abs_logo = os.path.join(host_project_root, project_logo)
        if os.path.isfile(abs_logo):
            config["theme"].logo = abs_logo
            config["theme"]["logo"] = abs_logo
            logger.info("load_gendoc_config: logo = %s", abs_logo)
        else:
            logger.warning("load_gendoc_config: logo not found at %s", abs_logo)

    # ── Site directory ─────────────────────────────────────────────────────
    site_subdir = cfg.get("mkdocs", {}).get("site_dir")
    if site_subdir:
        config["site_dir"] = site_subdir
        logger.info("load_gendoc_config: site_dir = %s", site_subdir)

    return config
