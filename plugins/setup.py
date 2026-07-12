from setuptools import setup

setup(
    name="gendoc-plugins",
    version="0.1.0",
    py_modules=["external_docs"],
    entry_points={
        "mkdocs.plugins": [
            "external-docs = external_docs:ExternalDocsPlugin",
        ],
    },
)
