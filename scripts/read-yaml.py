#!/usr/bin/env python3
"""
read-yaml.py -- read a value from gendoc.yml by dotted path.

Usage:
    python3 read-yaml.py GENDOC_YML_PATH dotted.key.path [--join]

Outputs the value to stdout. YAML booleans are lowercased ("true"/"false").
Use --join for list values: elements are comma-joined.
"""
import sys

import yaml


def read_yaml(yaml_path: str, key_path: str) -> object:
    """Walk a dotted key path through a YAML file and return the value."""
    with open(yaml_path, "r") as f:
        cfg = yaml.safe_load(f)

    value = cfg
    for key in key_path.split("."):
        if isinstance(value, dict) and key in value:
            value = value[key]
        elif isinstance(value, list):
            try:
                value = value[int(key)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return value


def format_value(value: object, join_char: str = None) -> str:
    """Format a YAML value for shell consumption.

    Booleans are lowercased. Lists are joined with join_char when provided.
    None returns the empty string.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if join_char is not None and isinstance(value, list):
        return join_char.join(str(v) for v in value)
    return str(value)


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} GENDOC_YML dotted.key.path [--join|--join-space]", file=sys.stderr)
        sys.exit(1)

    yaml_path = sys.argv[1]

    # ── Batch mode: key1=VAR1 key2=VAR2 ... ─────────────────────────────
    # Emits shell variable assignments for eval.  Keys are the dotted YAML
    # paths; the shell variable name follows the equals sign.
    # Suffix :join (comma) or :join-space (space) on var_name joins list values.
    if "--batch" in sys.argv:
        for arg in sys.argv[2:]:
            if arg.startswith("--"):
                continue
            if "=" not in arg:
                print(f"read-yaml.py --batch: argument '{arg}' missing '=' separator", file=sys.stderr)
                sys.exit(1)
            key_path, var_spec = arg.split("=", 1)
            join_char = None
            if var_spec.endswith(":join-space"):
                var_name = var_spec[:-len(":join-space")]
                join_char = " "
            elif var_spec.endswith(":join"):
                var_name = var_spec[:-len(":join")]
                join_char = ","
            else:
                var_name = var_spec
            value = read_yaml(yaml_path, key_path)
            print(f"{var_name}='{format_value(value, join_char=join_char)}'")
        return

    # ── Single-key mode ─────────────────────────────────────────────────
    key_path = sys.argv[2]
    join_char = None
    if "--join" in sys.argv:
        join_char = ","
    elif "--join-space" in sys.argv:
        join_char = " "

    value = read_yaml(yaml_path, key_path)
    print(format_value(value, join_char=join_char), end="")


if __name__ == "__main__":
    main()
