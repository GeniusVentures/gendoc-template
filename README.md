# gendoc-template

A reusable MkDocs documentation template for GNUS C++ projects.

Add as a git submodule, configure one YAML file, and get a complete documentation site with
selectable Material-based themes, mermaid diagrams, mathjax rendering, Doxygen source reference integration,
`llms.txt` agent catalogs, and an optional "Ask AI" widget grounded on your own docs --
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

# One-time Cloudflare setup (creates the Pages project, generates wrangler.toml,
# and -- if llms.ask.enabled -- deploys the Ask AI worker and prompts for API keys)
gendoc-template/scripts/setup.sh

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
| doxybook2 | Download the **GeniusVentures fork v1.6.3** release binaries from [GeniusVentures/doxybook2 releases](https://github.com/GeniusVentures/doxybook2/releases/tag/v1.6.3) (not the upstream `npm` package; Windows binaries coming soon), or run `gendoc-template/scripts/install-deps.sh` for one-command install | Doxygen XML to Markdown conversion |
| Node.js + Wrangler | `npm install -g wrangler` | Cloudflare deployment, Ask widget compilation (TypeScript is fetched automatically via `npx`) |
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
| `logo` | string | no | Path to project logo image relative to host project root |
| `generator` | bool | no | Set `false` to hide "Made with Material for MkDocs" footer attribution |

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

### `theme` -- Site Theme

The theme is selected in the **parent project's** `gendoc.yml`; do not edit `mkdocs.yml`
in the submodule. Every build loads `stylesheets/base.css` first and then the selected
preset from `themes/`.

```yaml
theme:
  name: "protocol"
```

| Name | Description |
|------|-------------|
| `default` | Original GNUS cyan theme and the fallback when no valid theme is configured |
| `indigo` | Spacious indigo theme with a separate right-hand table of contents |
| `protocol` | Zinc and emerald API-documentation theme inspired by Tailwind Plus Protocol |
| `custom` | A CSS file owned by the parent project; requires `custom_css` |

To use a parent-project stylesheet:

```yaml
theme:
  name: "custom"
  custom_css: "docs/my-theme.css" # relative to the parent project root
```

The loader copies that file into the build assets and loads it after `base.css`. A missing
file or unknown preset produces a warning and falls back to `default`.

#### Creating a Theme

Start with a small custom stylesheet in the parent project. `base.css` already owns the
shared desktop grid, resizable left sidebar, mobile navigation behavior, figure alignment,
and content bottom spacing. A theme should concentrate on colors, type, spacing, and
component appearance unless it deliberately needs a different layout.

At minimum, define both Material color schemes and the Ask AI variables used by the widget:

```css
[data-md-color-scheme="default"] {
  --md-primary-fg-color: #ffffff;
  --md-primary-bg-color: #18181b;
  --md-accent-fg-color: #10b981;
  --md-typeset-a-color: #059669;
}

[data-md-color-scheme="slate"] {
  --md-primary-fg-color: #18181b;
  --md-primary-bg-color: #ffffff;
  --md-accent-fg-color: #34d399;
  --md-typeset-a-color: #34d399;
}

:root {
  --ask-accent: #10b981;
  --ask-drawer-bg: #ffffff;
  --ask-drawer-fg: #18181b;
  --ask-drawer-border: #e4e4e7;
  --ask-dark-bg: #18181b;
  --ask-dark-fg: #f4f4f5;
  --ask-dark-border: #3f3f46;
}
```

Useful MkDocs Material selectors include `.md-header`, `.md-search__form`,
`.md-header__button[for="__drawer"]`, `.md-sidebar--primary`, `.md-nav__link`,
`.md-nav--primary .md-nav__title`, `.md-content__inner`, `.md-typeset`,
`.md-typeset .highlight`, `.md-typeset .admonition`, and `.md-footer`. Scope palette and
contrast changes under the two color-scheme attributes so the light/dark toggle remains
correct. Test navigation, search results, inline and fenced code, tables, admonitions,
mobile navigation, and the Ask AI drawer in both modes.

To contribute a reusable built-in preset:

1. Add `themes/<name>.css`; keep the filename lowercase and use only letters, numbers, and hyphens.
2. Add `<name>` to `BUILTIN_PRESETS` in `scripts/load-theme.py`.
3. If the design needs a Material feature such as `toc.integrate`, add that behavior to
   `_configure_material_features()` instead of asking every parent project to edit `mkdocs.yml`.
4. Add the preset to the table above and to the comment in `gendoc.yml.example`.
5. Build a parent project with `theme.name: "<name>"`, then verify the emitted HTML loads
   `/stylesheets/base.css` before `/themes/<name>.css`.

### `navigation` -- Sidebar Behavior

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `navigation_sections` | bool | `false` | Use the mobile-friendly accordion/drill-down sidebar. Set `true` for always-expanded Material sections. |
| `navigation_indexes` | bool | `true` | Allow section index pages to act as navigation entries. |
| `section_index` | bool | `true` | Enable the MkDocs section-index plugin. |
| `generate_index` | bool | `false` | Regenerate `index.md` from the configured source documents during builds. |
| `sections` | list | `[]` | Define the hand-written navigation sections merged before generated source references. |

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
| `production_branch` | string | no | Production branch for the Pages project (default: `"main"`) |
| `custom_domain` | string | no | Custom domain -- setup.sh prints the dashboard steps |
| `compatibility_date` | string | **yes** (for deploy) | Cloudflare compatibility date (e.g. `"2024-01-01"`) |

**Credentials:** `setup.sh` uses `wrangler login` (browser OAuth). For CI/CD, Wrangler
reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment -- never put
credentials in `gendoc.yml`.

### `llms` -- llms.txt Agent Catalogs

Generates `llms.txt`, `llms-full.txt`, and audience-specific catalogs (`llms-technical.txt`,
etc.) that AI coding agents use to discover and fetch project documentation. See
[Agent Catalogs (llms.txt)](#agent-catalogs-llmstxt) for the full workflow.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | bool | **yes** | Set `true` to enable catalog generation |
| `site_url` | string | **yes** | Canonical URL of the deployed site (e.g. `"https://gcs.gnus.ai"`) |
| `corpus_cache` | string | no | Directory for cached Google Doc exports (default: `"llms-corpus"`) |
| `meta_file` | string | no | Editorial metadata file (default: `"llms-meta.json"`) |
| `audiences` | map | no | Audience-specific catalog definitions -- keys are output filenames, values have `title` and `categories` (see [gendoc.yml.example](gendoc.yml.example)) |
| `google_docs` | list | no | Public Google Docs to fetch as markdown and publish to the corpus |
| `related_catalogs` | list | no | Links to related `llms.txt` files from other projects |
| `ask` | map | no | Ask AI widget settings (see below) |

### `llms.ask` -- Ask AI Widget

An optional site widget (floating button + chat drawer) answering questions **only from the
project's documentation**, with source citations.  See [Ask AI Widget](#ask-ai-widget).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | bool | **yes** | Set `true` to build the widget and deploy its worker |
| `endpoint` | string | no | Custom worker URL + `/api/ask` for shared-worker / custom-domain setups (e.g. `https://ask.gnus.ai/api/ask`). When unset, `setup.sh` auto-captures the `workers.dev` URL after deploy. |
| `title` | string | no | Button/drawer title and bot name (default: `"Ask <project.name>"`) |
| `placeholder` | string | no | Input placeholder text |
| `worker_name` | string | no | Cloudflare Worker name (default: `<pages_project_name>-ask`) |
| `allowed_origins` | list | no | Origins allowed to call the worker (default: `[site_url]`) |
| `providers` | string | no | LLM provider chain, tried in order (default: `"openrouter,gemini"`) |
| `gemini_model` | string | no | Gemini model id (default: `"gemini-2.5-flash"`) |
| `openrouter_models` | string | no | Comma-separated OpenRouter `:free` fallback models |

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

The template's `build-navigation.py` merges this hand-written navigation with
generated source reference pages into a combined `SUMMARY_EXT.md` that MkDocs consumes.

Place your actual markdown files in the same directory as `SUMMARY.md` (or
subdirectories referenced by relative paths in `SUMMARY.md`).

The source reference sections are appended automatically by `build-navigation.py`
after your hand-written entries -- one section per `source_references` set.  No
placeholder heading is needed in `SUMMARY.md`.

## Agent Catalogs (llms.txt)

The build pipeline generates `llms.txt` files -- machine-readable catalogs that AI coding
agents (Claude Code, Codex, etc.) use to discover, fetch, and reason about your project's
documentation.  This is based on the [llms.txt](https://llmstxt.org/) standard.

### Generated Files

| File | Purpose |
|------|---------|
| `llms.txt` | Master catalog with audience-specific catalog links and key documents |
| `llms-technical.txt` | Architecture & developer reference -- documents with categories matching `[technical, architecture, api, nodes]` |
| `llms-full.txt` | Full corpus: all document content inlined for offline agent consumption (excludes source reference sets) |

### How It Works

1. **Scaffold** -- `build-llms.py` scans your `SUMMARY.md` (or `SUMMARY_EXT.md`) to discover
   every hand-written document, plus each `source_references` set.  It writes a scaffold
   `llms-meta.json` with content hashes, empty descriptions, and default flags.

2. **Editorial pass** -- Run `/update-catalogs` in Claude Code.  This reads every scaffolded
   document, writes agent-oriented descriptions (≤140 chars saying what questions each doc
   answers), assigns categories, pins key whitepaper-tier documents, and marks source
   reference sets as optional.  The command edits `llms-meta.json` directly.

3. **Regenerate** -- Re-run `build.sh`.  `build-llms.py` reads `llms-meta.json`, reconciles
   hashes against current content, and emits the final catalog files into the `site/`
   directory.  A clean run prints "All catalog entries have current descriptions and categories."

### Editorial Metadata (`llms-meta.json`)

This file is committed to the host repo.  Each entry stores:

| Field | Description |
|-------|-------------|
| `description` | One line (≤140 chars) telling an AI agent what questions this doc answers |
| `category` | One of: `sales`, `product`, `pricing`, `technical`, `architecture`, `api`, `nodes`, `token`, `investors` |
| `optional` | `true` for reference material agents should fetch only when relevant |
| `pinned` | `true` for ≤5 whitepaper-tier documents featured in the master catalog |
| `exclude` | `true` to hide from published catalogs |
| `hash` | Content hash for detecting stale descriptions |

Never edit the generated files under `site/` -- all changes go through `llms-meta.json`
and a re-run of `build.sh`.

## Ask AI Widget

When `llms.ask.enabled` is `true`, the site gets a floating "✦ Ask" button that opens a
chat drawer, plus an "Ask AI" row pinned above the built-in search results.  Answers are
grounded **exclusively on the project's own documentation** and cite source URLs; unrelated
questions are refused without spending any LLM quota.

### Architecture

Everything for the feature lives under `ask-ai/`:

```
ask-ai/
├── widget-src/                 # TypeScript widget source (strict mode)
├── worker/ask.js               # Cloudflare Worker: /api/ask endpoint
├── wrangler-ask.toml.template  # Worker config template ({{TOKENS}} from gendoc.yml)
└── wrangler-ask.toml           # Generated by setup.sh (gitignored)
```

- **Widget** -- compiled by `scripts/build-widget.sh` (via `npx` TypeScript) to ES modules
  at `javascripts/ask/` (gitignored), served like every other script asset.  It reads
  `/ask-config.json` (generated by `build-llms.py`) and silently does nothing when the
  feature is disabled.  The chat conversation persists across page navigation.
- **Worker** -- retrieval uses the llms.txt catalogs themselves: entry descriptions are
  scored against the question, the top documents are fetched and sent to the LLM with a
  strict "answer only from context" prompt, and the response streams back to the widget.
  No vector database, no crawler, no per-site index to maintain -- improving the catalog
  descriptions improves the widget.
- **Provider chain** -- `gemini,openrouter` by default, tried in order; a provider without
  a configured key, or one that is over quota, falls through to the next.  Free-tier
  budgets: Gemini Flash ~1,500 requests/day; OpenRouter `:free` models 50/day (1,000/day
  after a one-time $10 credit purchase).  Combined: roughly 2,500 answers/day at $10
  lifetime cost.

### Setup

1. Set `llms.ask.enabled: true` (and optionally `title`, `allowed_origins`, ...) in
   `gendoc.yml`, then run `gendoc-template/scripts/setup.sh`.  It generates the worker
   config, deploys the worker (named `<pages_project_name>-ask`), captures the endpoint
   URL to `ask-ai/.endpoint`, and prompts for the Gemini / OpenRouter API keys (stored
   as Worker secrets -- never in any file).
2. Run `build.sh` + `deploy.sh` -- the site now ships `ask-config.json` and the widget
   activates.

For a shared worker across multiple projects, set `llms.ask.endpoint` to a custom URL
(e.g. `https://ask.gnus.ai/api/ask`) before running `setup.sh`.  The configured endpoint
is written to `ask-ai/.endpoint` and used by `build-widget.sh` to generate
`ask-config.json`.

Re-running `setup.sh` after changing `llms.ask.*` values re-deploys the worker with the
updated configuration (secrets are only prompted interactively and can be skipped).

**Recommended:** add a Cloudflare rate-limiting rule on the worker route (e.g. 10 req/min
per IP on `/api/ask`) -- the free plan includes one rule per zone, and it protects the
shared daily LLM quotas.

## Building Locally

From the host project root, run the full build pipeline:

```bash
gendoc-template/scripts/build.sh
```

This executes steps in sequence:

1. **Source reference** -- For each `source_references` set, Doxygen parses the source,
   doxybook2 converts the XML to Markdown, and `build-navigation.py` merges each set's
   navigation into your hand-written nav.
2. **Index regeneration** -- `generate-index.sh` rebuilds `index.md` from
   `index.md.template` and heading structures extracted from all hand-written
   `.md` files (skipped silently when the script or template is absent).
3. **Ask widget** -- `build-widget.sh` compiles `ask-ai/widget-src/` to ES modules at
   `javascripts/ask/` and generates `ask-config.json` (skipped when
   `llms.ask.enabled` is `false` -- the widget no-ops without it).
4. **MkDocs build** -- MkDocs builds the static site into the configured `site_dir`
   (default `site/`).
5. **Agent catalogs** -- `build-llms.py` generates `llms.txt`, `llms-full.txt`,
   and audience-specific catalogs from `SUMMARY.md` and `llms-meta.json` (if
   `llms.enabled` is `true` in `gendoc.yml`).

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

## Deploying to Cloudflare

**One-time setup** (per host project):

```bash
gendoc-template/scripts/setup.sh
```

Authenticates via browser OAuth (`wrangler login`), creates the Pages project, generates
`wrangler.toml`, prints custom-domain instructions, and -- when `llms.ask.enabled` -- deploys
the Ask AI worker and prompts for provider API keys.  Safe to re-run; it skips what already
exists and syncs worker configuration changes.

**Deploying the site** (every release):

```bash
# For CI/CD or headless environments, credentials come from the environment:
export CLOUDFLARE_API_TOKEN="your-cloudflare-api-token"
export CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id"

# Run the full build + deploy pipeline
gendoc-template/scripts/deploy.sh
```

The script deploys the built site to Cloudflare Pages and prints the deployed URL
(typically `https://<project-name>.pages.dev`). Use `deploy-ask.sh` separately
when you need to deploy only the Ask AI Worker.

### GitHub Actions

This repository's `.github/workflows/build.yml` validates every built-in theme, compiles
the Python hooks, and typechecks the Ask AI worker on pull requests and pushes to `develop`
or `main`.

Parent projects can call the reusable `.github/workflows/deploy.yml` workflow. It deploys
the Ask AI Worker first when `llms.ask.enabled` is true and the project owns its Worker,
then builds and deploys Pages. A configured `llms.ask.endpoint` is treated as a shared or
externally managed Worker and is left untouched unless `llms.ask.deploy_worker: true`.
Add this small wrapper to the parent repository as `.github/workflows/deploy.yml`:

```yaml
name: Deploy documentation

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  docs:
    uses: GeniusVentures/gendoc-template/.github/workflows/deploy.yml@develop
    with:
      template-path: gendoc-template
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

The parent repository must contain `gendoc.yml` at its root and the template as a direct
child (normally the `gendoc-template` submodule). Add `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. The API token needs Cloudflare Pages
Edit and Workers Scripts Edit permissions; if `llms.ask.endpoint` creates a custom-domain
route, also grant the relevant zone's Workers Routes Edit permission. Provider API keys
remain Cloudflare Worker secrets, not GitHub secrets. Pin the reusable workflow to a
release tag or commit SHA for production once the desired template version is released.

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
project's configuration.  Likewise `llms-meta.json` and `llms-corpus/` are source, not
artifacts -- commit them.

## Directory Layout

```
your-project/                   # HOST PROJECT ROOT
├── gendoc.yml                  # Your project's configuration (YOU CREATE THIS)
├── llms-meta.json              # Agent catalog editorial metadata (generated by build-llms.py)
├── docs/                       # Example hand-written docs directory
│   ├── SUMMARY.md              # Hand-written navigation (YOU CREATE THIS)
│   ├── introduction.md
│   ├── installation.md
│   └── guides/
├── src/                        # Your C++ source (for Doxygen)
├── gendoc-template/            # Git submodule (read-only, versioned separately)
│   ├── .claude/
│   │   └── commands/
│   │       └── update-catalogs.md  # Claude Code command for editorial pass
│   ├── ask-ai/                 # Ask AI widget + worker (see Ask AI Widget)
│   │   ├── widget-src/         # TypeScript widget source
│   │   ├── worker/ask.js           # Cloudflare Worker (/api/ask)
│   │   ├── worker/search-normalizer.js  # SymSpell-based spelling correction
│   │   └── wrangler-ask.toml.template  # Worker config template
│   ├── gendoc.yml.example      # Config template -- copy to host root
│   ├── index.md.template        # Sample template for generate-index.sh
│   ├── mkdocs.yml              # MkDocs config with Material theme
│   ├── requirements.txt        # Python dependencies
│   ├── wrangler.toml.template  # Pages config template
│   ├── .github/workflows/
│   │   ├── build.yml           # Theme, Python, and Ask worker CI
│   │   └── deploy.yml          # Reusable parent-project Cloudflare deployment
│   ├── scripts/
│   │   ├── setup.sh            # One-time Cloudflare setup (Pages + ask worker)
│   │   ├── build.sh            # Full build pipeline
│   │   ├── build-source-reference.sh  # Doxygen + doxybook2
│   │   ├── build-llms.py       # llms.txt catalog generator
│   │   ├── build-navigation.py     # Nav merging
│   │   ├── build-widget.sh     # Ask widget TypeScript compilation
│   │   ├── deploy.sh           # Cloudflare Pages deploy
│   │   ├── deploy-ask.sh       # Ask worker standalone deploy
│   │   ├── generate-index.sh   # index.md regeneration from headings
│   │   ├── read-yaml.py        # YAML config reader
│   │   └── load-gendoc-config.py   # MkDocs hook
│   ├── stylesheets/            # Shared, theme-independent base.css
│   ├── themes/                 # Selectable default, indigo, and protocol presets
│   ├── javascripts/            # Theme enhancements (+ generated ask/ output, gitignored)
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
| `doxybook2 failed` | doxybook2 not installed or wrong version | Download the [GeniusVentures fork v1.6.3](https://github.com/GeniusVentures/doxybook2/releases/tag/v1.6.3) release binaries (the upstream `npm` package is not used) |
| `wrangler: command not found` | Wrangler not installed | Run `npm install -g wrangler` |
| Wrangler authentication fails in CI | Missing deploy credentials | Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets |
| `Warning: gendoc.yml not found` (during mkdocs serve) | The MkDocs hook looks for gendoc.yml at the host root and falls back to defaults if missing | Create `gendoc.yml` at the host project root, or edit `mkdocs.yml` directly if you prefer |
| `No SUMMARY.md found` (warning) | Hand-written docs directory has no `SUMMARY.md` | Create `SUMMARY.md` in your hand-written docs directory (see [Hand-Written Docs](#hand-written-docs)) |
| `22 entries need editorial attention` (catalog) | `llms-meta.json` has un-reviewed entries | Run `/update-catalogs` in Claude Code to fill in descriptions and categories |
| `Neither SUMMARY.md nor SUMMARY_EXT.md found` (catalog) | `build-llms.py` cannot find the navigation file | Verify `paths.handwritten_docs` in `gendoc.yml` points at the correct directory |
| `WARNING: SUMMARY.md links missing file` (catalog) | A document listed in SUMMARY.md does not exist on disk | Check for broken links or moved files in your SUMMARY.md |
| `could not determine executable to run` (widget build) | npx invoked with the package name as the command | `build-widget.sh` must use `npx -y -p typescript@5 tsc ...` (`--package` form) |
| `Cannot use import statement outside a module` (browser console) | Widget script loaded as a classic script | The mkdocs.yml entry needs the object form with `type: module` (see mkdocs.yml) |
| Ask button never appears | `ask-config.json` missing from the site | Set `llms.ask.enabled: true`, run `setup.sh` to deploy the worker and capture the endpoint, then re-run `build.sh` + `deploy.sh` |
| Ask answers fail with a CORS error | Site origin not allowed by the worker | Add the origin to `llms.ask.allowed_origins` and re-run `setup.sh` |
| "The assistant is temporarily over capacity" | No provider secrets set, or daily quotas exhausted | Set `GEMINI_API_KEY` / `OPENROUTER_API_KEY` via `setup.sh` or `wrangler secret put`, or wait for quota reset |

## License

MIT — see [LICENSE](LICENSE).
