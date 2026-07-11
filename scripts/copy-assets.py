"""
copy-assets.py

MkDocs hook that copies the template's javascripts/, stylesheets/, and
themes/ directories into the built site directory.

(Only change from the original: "themes" added to ASSET_DIRS so the
theme-loader presets ship with the build. See load-theme.py for how the
active theme is selected.)
"""

import os
import shutil

ASSET_DIRS = ("javascripts", "stylesheets", "themes")


def on_post_build(config):
    """Mirror each template asset directory into the site directory."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    template_root = os.path.dirname(script_dir)
    site_dir = config["site_dir"]

    for asset_dir in ASSET_DIRS:
        src = os.path.join(template_root, asset_dir)
        dst = os.path.join(site_dir, asset_dir)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
