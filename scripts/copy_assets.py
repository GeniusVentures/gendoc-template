"""
copy_assets.py

MkDocs hook that copies the template's ``javascripts/`` and ``stylesheets/``
into the built site directory.

Why
---
These assets live at the template root, *outside* the host project's
``docs_dir``.  mkdocs only copies files that reside under ``docs_dir``, yet
``extra_javascript`` / ``extra_css`` reference them via absolute paths such as
``/javascripts/nav-state.js``.  Without copying them into the site, those
references 404.  (The reference project avoids this by keeping the same folders
physically inside its ``docs/`` directory; this template cannot, because its
``docs_dir`` is the host's external architecture folder.)

``on_post_build`` runs for both ``mkdocs build`` and ``mkdocs serve``, so asset
resolution is fixed in either case from a single place.

Registered in mkdocs.yml via:

    hooks:
      - scripts/copy_assets.py
"""

import os
import shutil

# Asset directories at the template root that must be mirrored into the site.
ASSET_DIRS = ("javascripts", "stylesheets")


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
