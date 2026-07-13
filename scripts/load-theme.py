"""
load-theme.py

MkDocs hook that selects which theme stylesheet(s) to load based on the
`theme:` block in the host project's gendoc.yml. Runs *after*
load-gendoc-config.py in the hooks list.

Supported gendoc.yml block:

    theme:
      name: "protocol"        # one of the presets shipped in themes/*.css
                               # ("default", "indigo", "protocol"), or "custom"
      custom_css: ""          # required when name == "custom" — path to your
                               # own CSS file, relative to the HOST PROJECT ROOT

Behavior:
  - Always loads stylesheets/base.css first (structural rules: sidebar sizing,
    grid layout, resizer, figure alignment — theme-agnostic).
  - Then loads themes/<name>.css for a built-in preset.
  - If name == "custom", copies custom_css into the template's themes/
    directory as "custom.css" (so copy-assets.py's existing mirror step picks
    it up unchanged) and loads themes/custom.css instead.
  - Falls back to the "default" preset (with a warning) if the requested
    preset file doesn't exist, or if gendoc.yml / the theme block is missing.

Registered in mkdocs.yml via:

    hooks:
      - scripts/load-gendoc-config.py
      - scripts/load-theme.py
"""

import logging
import os
import shutil

import yaml

logger = logging.getLogger("mkdocs")

BUILTIN_PRESETS = ("default", "indigo", "protocol")


def _configure_material_features(config, name):
    """Apply the small Material feature changes required by a preset."""
    features = config["theme"]["features"]
    if name == "protocol":
        # Protocol nests the active page's headings below its left-nav entry.
        if "toc.integrate" not in features:
            features.append("toc.integrate")
    elif "toc.integrate" in features:
        features.remove("toc.integrate")


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
    template_root = os.path.dirname(script_dir)          # scripts/ → template root
    host_project_root = os.path.dirname(template_root)   # template/ → host project root
    themes_dir = os.path.join(template_root, "themes")

    cfg = _load_gendoc_yml(host_project_root)
    theme_cfg = cfg.get("theme", {}) if isinstance(cfg.get("theme"), dict) else {}
    name = theme_cfg.get("name", "default")

    stylesheets = ["/stylesheets/base.css"]

    if name == "custom":
        custom_rel = theme_cfg.get("custom_css")
        if not custom_rel:
            logger.warning(
                "load_theme: theme.name is 'custom' but theme.custom_css is not "
                "set — falling back to the 'default' preset."
            )
            name = "default"
        else:
            src = os.path.join(host_project_root, custom_rel)
            if os.path.isfile(src):
                os.makedirs(themes_dir, exist_ok=True)
                dst = os.path.join(themes_dir, "custom.css")
                shutil.copy2(src, dst)
                stylesheets.append("/themes/custom.css")
                logger.info("load_theme: custom theme = %s (copied to themes/custom.css)", src)
            else:
                logger.warning(
                    "load_theme: theme.custom_css %s not found — falling back to "
                    "the 'default' preset.", src
                )
                name = "default"

    if name != "custom":
        if name not in BUILTIN_PRESETS:
            logger.warning(
                "load_theme: unknown theme.name '%s' (built-in presets: %s) — "
                "falling back to 'default'.", name, ", ".join(BUILTIN_PRESETS)
            )
            name = "default"
        preset_path = os.path.join(themes_dir, f"{name}.css")
        if not os.path.isfile(preset_path):
            logger.warning("load_theme: preset file %s missing — using 'default'.", preset_path)
            name = "default"
        stylesheets.append(f"/themes/{name}.css")

    _configure_material_features(config, name)

    config["extra_css"] = stylesheets
    logger.info("load_theme: extra_css = %s", stylesheets)

    return config
