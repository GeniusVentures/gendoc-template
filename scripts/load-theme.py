"""
load-theme.py

MkDocs hook that loads the theme stylesheet selected by the `theme:` block
in the host project's gendoc.yml.

Supported gendoc.yml block:

    theme:
      name: "emerald"          # loads themes/<name>.css — any .css file in
                                # the themes/ directory works; "default" is
                                # the fallback
      custom_css: ""           # used only when name == "custom" — path to a
                                # parent-project CSS file, relative to HOST ROOT

Behavior:
  - Always loads stylesheets/base.css first (structural rules: sidebar sizing,
    grid layout, resizer, figure alignment — theme-agnostic).
  - Loads themes/<name>.css if the file exists, otherwise falls back to
    themes/default.css with a warning.
  - If name == "custom", copies custom_css into themes/custom.css and loads
    that instead.
"""

import logging
import os
import shutil

import yaml

logger = logging.getLogger("mkdocs")


def _load_gendoc_yml(host_project_root):
    gendoc_path = os.path.join(host_project_root, "gendoc.yml")
    if not os.path.isfile(gendoc_path):
        return {}
    try:
        with open(gendoc_path, "r") as f:
            cfg = yaml.safe_load(f) or {}
    except yaml.YAMLError as exc:
        logger.warning("load_theme: failed to parse %s — %s", gendoc_path, exc)
        return {}
    return cfg if isinstance(cfg, dict) else {}


def on_config(config):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    template_root = os.path.dirname(script_dir)
    host_project_root = os.path.dirname(template_root)
    themes_dir = os.path.join(template_root, "themes")

    cfg = _load_gendoc_yml(host_project_root)
    theme_cfg = cfg.get("theme", {}) if isinstance(cfg.get("theme"), dict) else {}
    name = theme_cfg.get("name", "default")

    stylesheets = ["/stylesheets/base.css"]

    if name == "custom":
        custom_rel = theme_cfg.get("custom_css")
        if not custom_rel:
            logger.warning(
                "load_theme: theme.name is 'custom' but theme.custom_css "
                "is not set — falling back to 'default'."
            )
            name = "default"
        else:
            src = os.path.join(host_project_root, custom_rel)
            if os.path.isfile(src):
                os.makedirs(themes_dir, exist_ok=True)
                dst = os.path.join(themes_dir, "custom.css")
                shutil.copy2(src, dst)
                stylesheets.append("/themes/custom.css")
                logger.info("load_theme: custom theme = %s", src)
            else:
                logger.warning(
                    "load_theme: theme.custom_css %s not found — "
                    "falling back to 'default'.", src
                )
                name = "default"

    if name != "custom":
        preset_path = os.path.join(themes_dir, f"{name}.css")
        if not os.path.isfile(preset_path):
            logger.warning(
                "load_theme: themes/%s.css not found — falling back to 'default'.", name
            )
            name = "default"
        stylesheets.append(f"/themes/{name}.css")

    config["extra_css"] = stylesheets
    logger.info("load_theme: extra_css = %s", stylesheets)

    return config
