# gendoc-template

A reusable MkDocs documentation template for GNUS C++ projects.

Add as a git submodule, configure one YAML file, and get a complete documentation site with Material theme, mermaid diagrams, mathjax rendering, and Doxygen API reference integration — deployable to Cloudflare Pages.

## Quick Start

```bash
# Add to your GNUS project
git submodule add https://github.com/GeniusVentures/gendoc-template.git gendoc-template

# Copy and edit the config
cp gendoc-template/gendoc.yml gendoc.yml

# Install Python dependencies
python3 -m venv .venv && source .venv/bin/activate
pip install -r gendoc-template/requirements.txt

# Preview
cd gendoc-template && mkdocs serve
```

## Configuration

Edit `gendoc.yml` to point at your project:

```yaml
project:
  name: "Your Project Name"

paths:
  handwritten_docs: "docs/"
  cpp_source: "src/"

deploy:
  cloudflare:
    pages_project_name: "your-project-docs"
```

## Directory Layout

```
gendoc-template/
├── gendoc.yml              # Config template (copy and edit)
├── mkdocs.yml              # MkDocs + Material theme
├── requirements.txt        # Python dependencies
├── scripts/                # Build hooks and navigation
├── stylesheets/            # GNUS brand CSS
├── javascripts/            # Theme enhancements
├── doxygen-template/       # Doxygen config template
└── README.md
```

## Requirements

- Python 3.9+
- Doxygen (for API reference)
- doxybook2 (for Doxygen → Markdown conversion)
- Node.js + Wrangler (for Cloudflare Pages deploy)

## License

Proprietary — GNUS.AI / GeniusVentures
