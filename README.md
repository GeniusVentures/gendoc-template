# gendoc-template

A reusable MkDocs documentation template for GNUS C++ projects.

Add as a git submodule, configure one YAML file, and get a complete documentation site with
Material theme, mermaid diagrams, mathjax rendering, and Doxygen API reference integration --
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
#   paths.cpp_source          (e.g. "src/")
#   deploy.cloudflare.pages_project_name  (e.g. "myproject-docs")

# One-time Python setup
python3 -m venv .venv && source .venv/bin/activate
pip install -r gendoc-template/requirements.txt

# Preview (starts a local dev server at http://127.0.0.1:8000)
cd gendoc-template && mkdocs serve
```

## Prerequisites

| Tool | Install | Purpose |
|------|---------|---------|
| Python 3.9+ | System package or [python.org](https://python.org) | MkDocs and scripts |
| Doxygen | `brew install doxygen` (macOS) or `apt-get install doxygen` (Linux) | C++ API reference generation |
| doxybook2 | `npm install -g doxybook2` or see [doxybook2 on GitHub](https://github.com/matusnovak/doxybook2) | Doxygen XML to Markdown conversion |
| Node.js + Wrangler | `npm install -g wrangler` | Cloudflare Pages deployment |
| Hand-written docs directory | Create a directory with at minimum a `SUMMARY.md` file (see [Hand-Written Docs](#hand-written-docs)) | Site content |

Doxygen and doxybook2 are only required if you want API reference documentation (the
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
| `cpp_source` | string or list | no | C++ source root(s) for Doxygen. Can be one directory or a space-separated list |
| `exclude_patterns` | list | no | Source paths to exclude from Doxygen (e.g. `"*/thirdparty/*"`, `"*/build/*"`) |

### `mkdocs` -- MkDocs Settings

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `site_dir` | string | no | MkDocs output directory (default: `"site"`) |
| `use_directory_urls` | bool | no | Clean URLs without `.html` extension (default: `true`) |
| `strict` | bool | no | Build with `--strict` -- warnings become errors (default: `false`) |

### `doxygen` -- Doxygen Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output_dir` | string | **yes** | Intermediate XML output directory (gitignored, default: `"doxygen-output"`) |
| `generate_xml` | bool | no | Must be `true` for doxybook2 pipeline (default: `true`) |
| `generate_html` | bool | no | Not needed -- MkDocs handles HTML (default: `false`) |
| `file_patterns` | list | no | Source file extensions to scan |
| `recursive` | bool | no | Recurse into `cpp_source` subdirectories (default: `true`) |
| `strip_from_path` | string | no | Prefix to strip from file paths in generated docs |

### `api_reference` -- API Reference (doxybook2)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output_subdir` | string | no | Subdirectory under `handwritten_docs` for generated API docs (default: `"api-reference"`) |
| `base_url` | string | no | URL base path for generated API pages (default: `"/api-reference/"`) |
| `folders_to_generate` | list | no | Doxygen index categories to convert. Default: `[classes, files, modules, namespaces, pages]` |

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

## API Reference
```

The template's `build_navigation.py` merges this hand-written navigation with
generated API reference pages into a combined `SUMMARY_EXT.md` that MkDocs consumes.

Place your actual markdown files in the same directory as `SUMMARY.md` (or
subdirectories referenced by relative paths in `SUMMARY.md`).

The top-level `API Reference` heading is optional -- `build_navigation.py` prepends
the generated API navigation after your hand-written entries.  If you omit it,
API pages still appear in the nav.

## Building Locally

From the host project root, run the full build pipeline:

```bash
gendoc-template/scripts/build.sh
```

This executes three steps in sequence:

1. **API reference** -- Doxygen parses your C++ source, doxybook2 converts the XML to
   Markdown, and `build_navigation.py` merges the API navigation into your hand-written nav.
2. **MkDocs build** -- MkDocs builds the static site into the configured `site_dir`
   (default `site/`).

For live preview with hot-reload during writing:

```bash
cd gendoc-template && mkdocs serve
```

This starts a local server at `http://127.0.0.1:8000`.

The first build runs Doxygen on your entire source tree -- this can take a minute or two.
Subsequent builds are faster since Doxygen uses its own incremental cache.

If you only want hand-written content (no API reference), skip `build.sh` and run
`mkdocs serve` directly -- it works as long as `gendoc.yml` is correctly configured.

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
| `doxybook2 failed` | doxybook2 not installed or too old | Run `npm install -g doxybook2` or check [doxybook2 releases](https://github.com/matusnovak/doxybook2/releases) |
| `wrangler: command not found` | Wrangler not installed | Run `npm install -g wrangler` |
| `Error: CF_API_TOKEN environment variable is not set` | Missing deploy credentials | `export CF_API_TOKEN="your-token"` and `export CF_ACCOUNT_ID="your-account-id"` |
| `Warning: gendoc.yml not found` (during mkdocs serve) | The MkDocs hook looks for gendoc.yml at the host root and falls back to defaults if missing | Create `gendoc.yml` at the host project root, or edit `mkdocs.yml` directly if you prefer |
| `No SUMMARY.md found` (warning) | Hand-written docs directory has no `SUMMARY.md` | Create `SUMMARY.md` in your hand-written docs directory (see [Hand-Written Docs](#hand-written-docs)) |

## License

Proprietary -- GNUS.AI / GeniusVentures
