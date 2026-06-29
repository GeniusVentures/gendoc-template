# gendoc-template

A reusable MkDocs documentation template for GNUS C++ projects.

Add as a git submodule, configure one YAML file, and get a complete documentation site with
Material theme, mermaid diagrams, mathjax rendering, and Doxygen source reference integration --
deployable to Cloudflare Pages.

## Quick Start

```bash
# Add to your GNUS project (run from the host project root)
git submodule add https://github.com/GeniusVentures/gendoc-template.git gendoc-template

# Copy the example config to the HOST PROJECT ROOT (the directory containing
# the gendoc-template submodule -- NOT inside the submodule itself)
cp gendoc-template/gendoc.yml.example gendoc.yml

# Edit gendoc.yml for your project -- at minimum, set:
#   project.name              (e.g. "MyProject")
#   paths.handwritten_docs    (e.g. "docs/")
#   source_references         (at least one set; e.g. source: "src/", file_patterns: ["*.cpp", "*.h"])
#   deploy.cloudflare.pages_project_name  (e.g. "myproject-docs")

# One-time Python setup
python3 -m venv .venv && source .venv/bin/activate
pip install -r gendoc-template/requirements.txt

# Preview the built site (build first, then serve the site/ directory)
gendoc-template/scripts/build.sh
cd gendoc-template/site && python3 -m http.server 8000
# → open http://127.0.0.1:8000
```

## Prerequisites

| Tool | Install | Purpose |
|------|---------|---------|
| Python 3.9+ | System package or [python.org](https://python.org) | MkDocs and scripts |
| Doxygen | `brew install doxygen` (macOS) or `apt-get install doxygen` (Linux) | C++ source reference generation |
| doxybook2 | Install the **GeniusVentures fork v1.6.2** from [GeniusVentures/doxybook2 releases](https://github.com/GeniusVentures/doxybook2/releases/tag/v1.6.2) (not the upstream `npm` package) | Doxygen XML to Markdown conversion |
| Node.js + Wrangler | `npm install -g wrangler` | Cloudflare Pages deployment |
| Hand-written docs directory | Create a directory with at minimum a `SUMMARY.md` file (see [Hand-Written Docs](#hand-written-docs)) | Site content |

Doxygen and doxybook2 are only required if you want source reference documentation (the
`gendoc-template/scripts/build.sh` pipeline).  MkDocs alone is sufficient for hand-written
content.

## Configuration Reference

Edit the `gendoc.yml` file you copied to the host project root.  Every path value in this
file is **relative to the HOST PROJECT ROOT** (the directory containing the gendoc-template
submodule), unless the path starts with `/`.

### `project` -- Project Identification

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Doxygen PROJECT_NAME and MkDocs site_name |
| `number` | string | no | Doxygen PROJECT_NUMBER version tag |
| `brief` | string | no | Doxygen PROJECT_BRIEF (one-line description) |
| `logo` | string | no | Path to project logo image (max 200x55px) |

### `paths` -- File Paths

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `handwritten_docs` | string | **yes** | Directory with hand-written markdown (becomes MkDocs docs_dir) |
| `exclude_patterns` | list | no | Source paths excluded from every Doxygen run (e.g. `"*/thirdparty/*"`, `"*/build/*"`) |

### `mkdocs` -- MkDocs Settings

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `site_dir` | string | no | MkDocs output directory (default: `"site"`) |
| `use_directory_urls` | bool | no | Clean URLs without `.html` extension (default: `true`) |
| `strict` | bool | no | Build with `--strict` -- warnings become errors (default: `false`) |

### `doxygen` -- Doxygen Configuration (shared by all source reference sets)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output_dir` | string | **yes** | Intermediate XML output directory (gitignored, default: `"doxygen-output"`) |
| `generate_xml` | bool | no | Must be `true` for doxybook2 pipeline (default: `true`) |
| `generate_html` | bool | no | Not needed -- MkDocs handles HTML (default: `false`) |
| `recursive` | bool | no | Recurse into each set's source directories (default: `true`) |
| `strip_from_path` | string | no | Prefix to strip from file paths in generated docs |

### `source_references` -- Source Reference Sets (doxybook2)

A list of sets -- one entry per body of source code to document.  Each set runs its own
Doxygen + doxybook2 pass and becomes its own nav section.  `paths.exclude_patterns` apply to
every set; each set's `exclude_patterns` are appended.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Internal id; used for the intermediate XML directory name (`doxygen-output/<name>/`) |
| `label` | string | no | Nav section label (defaults to `name`) |
| `language` | string | no | Language shown in the landing page prose (e.g. `"C++"`, `"Python"`) |
| `source` | string | **yes** | Doxygen INPUT -- one directory or a space-separated list |
| `file_patterns` | list | **yes** | Source file extensions to scan for this set (e.g. `["*.cpp", "*.h"]`, `["*.py"]`) |
| `exclude_patterns` | list | no | Extra excludes for this set only |
| `output_subdir` | string | **yes** | Subdirectory under `handwritten_docs` for generated docs (e.g. `"source-reference"`) |
| `base_url` | string | **yes** | URL base path in the site nav for generated pages (e.g. `"/source-reference/"`) |

### `deploy.cloudflare` -- Cloudflare Pages Deployment

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pages_project_name` | string | **yes** (for deploy) | Wrangler Pages project name |
| `compatibility_date` | string | **yes** (for deploy) | Cloudflare compatibility date (e.g. `"2024-01-01"`) |

**Credentials:** `CF_API_TOKEN` and `CF_ACCOUNT_ID` are set as environment variables --
never put them in `gendoc.yml`.

## Hand-Written Docs

The host project must have a hand-written documentation directory (the value of
`paths.handwritten_docs` in `gendoc.yml`).  Inside that directory, create a **SUMMARY.md**
file using GitBook/literate-nav format:

```markdown
## Getting Started
- [Introduction](introduction.md)
- [Installation](installation.md)

## Guides
- [Building](guides/building.md)
- [Configuration](guides/configuration.md)
```

The template's `build_navigation.py` merges this hand-written navigation with
generated source reference pages into a combined `SUMMARY_EXT.md` that MkDocs consumes.

Place your actual markdown files in the same directory as `SUMMARY.md` (or
subdirectories referenced by relative paths in `SUMMARY.md`).

The source reference sections are appended automatically by `build_navigation.py`
after your hand-written entries -- one section per `source_references` set.  No
placeholder heading is needed in `SUMMARY.md`.

## Building Locally

From the host project root, run the full build pipeline:

```bash
gendoc-template/scripts/build.sh
```

This executes steps in sequence:

1. **Source reference** -- For each `source_references` set, Doxygen parses the source,
   doxybook2 converts the XML to Markdown, and `build_navigation.py` merges each set's
   navigation into your hand-written nav.
2. **MkDocs build** -- MkDocs builds the static site into the configured `site_dir`
   (default `site/`).

Preview the built site by serving the `site/` directory with a static server. The
generated source reference links are root-absolute (e.g. `/source-reference/...`), so
the server root **must** be the `site/` directory -- `mkdocs serve` and opening
`site/index.html` from an IDE both break those links.

```bash
cd gendoc-template/site && python3 -m http.server 8000
```

Open `http://127.0.0.1:8000`. Re-run `build.sh` then refresh to see changes (there is
no live reload -- this serves the static build as-is).

The first build runs Doxygen on your entire source tree -- this can take a minute or two.
Subsequent builds are faster since Doxygen uses its own incremental cache.

If you only want hand-written content (no source reference), run `build.sh` (which still
runs the MkDocs build step) and then serve `site/` as above.

## Deploying to Cloudflare Pages

Prerequisites:
- Wrangler installed (`npm install -g wrangler`)
- `CF_API_TOKEN` and `CF_ACCOUNT_ID` set as environment variables
- `deploy.cloudflare.pages_project_name` and `deploy.cloudflare.compatibility_date`
  set in `gendoc.yml`

```bash
# Set credentials in the environment
export CF_API_TOKEN="your-cloudflare-api-token"
export CF_ACCOUNT_ID="your-cloudflare-account-id"

# Run the full build + deploy pipeline
gendoc-template/scripts/deploy.sh
```

The script generates `wrangler.toml` from a template, deploys the built site to Cloudflare
Pages, and prints the deployed URL (typically `https://<project-name>.pages.dev`).

## Host Project .gitignore

The gendoc-template submodule has its own `.gitignore`, but build artifacts are generated
in the **host project**.  Add these patterns to your host project's `.gitignore`:

```gitignore
# gendoc-template build artifacts
site/
doxygen-output/
.venv/
```

The `gendoc.yml` file itself **should** be committed to your host project -- it is your
project's configuration.

## Directory Layout

```
your-project/                   # HOST PROJECT ROOT
├── gendoc.yml                  # Your project's configuration (YOU CREATE THIS)
├── docs/                       # Example hand-written docs directory
│   ├── SUMMARY.md              # Hand-written navigation (YOU CREATE THIS)
│   ├── introduction.md
│   ├── installation.md
│   └── guides/
├── src/                        # Your C++ source (for Doxygen)
├── gendoc-template/            # Git submodule (read-only, versioned separately)
│   ├── gendoc.yml.example      # Config template -- copy to host root
│   ├── mkdocs.yml              # MkDocs config with Material theme
│   ├── requirements.txt        # Python dependencies
│   ├── scripts/
│   │   ├── build.sh            # Full build pipeline
│   │   ├── build_api_reference.sh  # Doxygen + doxybook2
│   │   ├── build_navigation.py     # Nav merging
│   │   ├── deploy.sh           # Cloudflare Pages deploy
│   │   └── load_gendoc_config.py   # MkDocs hook
│   ├── stylesheets/            # GNUS brand CSS
│   ├── javascripts/            # Theme enhancements
│   ├── doxygen-template/       # Doxygen config template
│   └── README.md
├── site/                       # Built site output (gitignored)
└── doxygen-output/             # Doxygen intermediate XML (gitignored)
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `gendoc.yml not found` | Config not created or in wrong location | Run `cp gendoc-template/gendoc.yml.example gendoc.yml` from the host project root |
| `mkdocs: command not found` | Python venv not activated | Run `source .venv/bin/activate` from the host project root, or install mkdocs globally |
| `Error: paths.handwritten_docs is required` | Missing required config field | Add `paths.handwritten_docs` to `gendoc.yml` pointing at your hand-written docs directory |
| `Doxygen failed` | `paths.cpp_source` points at a non-existent or empty directory | Verify `paths.cpp_source` points at existing C++ source |
| `doxybook2 failed` | doxybook2 not installed or wrong version | Install the [GeniusVentures fork v1.6.2](https://github.com/GeniusVentures/doxybook2/releases/tag/v1.6.2) (the upstream `npm` package is not used) |
| `wrangler: command not found` | Wrangler not installed | Run `npm install -g wrangler` |
| `Error: CF_API_TOKEN environment variable is not set` | Missing deploy credentials | `export CF_API_TOKEN="your-token"` and `export CF_ACCOUNT_ID="your-account-id"` |
| `Warning: gendoc.yml not found` (during mkdocs serve) | The MkDocs hook looks for gendoc.yml at the host root and falls back to defaults if missing | Create `gendoc.yml` at the host project root, or edit `mkdocs.yml` directly if you prefer |
| `No SUMMARY.md found` (warning) | Hand-written docs directory has no `SUMMARY.md` | Create `SUMMARY.md` in your hand-written docs directory (see [Hand-Written Docs](#hand-written-docs)) |

## License

Proprietary -- GNUS.AI / GeniusVentures
