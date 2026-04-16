#!/usr/bin/env python3
"""
Transform a LinkML YAML schema into a graph manifest JSON file.

The manifest separates node types from edge types, resolves inheritance,
and produces a flat structure suitable for generating SQLite schemas
and property graph tooling.

Usage:
    uv run tools/linkml-to-graph-manifest.py features/lifeos-schema.yaml features/graph-manifest.json
"""

import json
import sys
from pathlib import Path

import yaml


def load_schema(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


def resolve_slots(cls_def: dict, all_slots: dict) -> dict[str, dict]:
    """Gather properties from both class attributes and referenced slots."""
    props = {}

    # Attributes defined directly on the class
    for aname, adef in (cls_def.get("attributes") or {}).items():
        if not isinstance(adef, dict):
            continue
        props[aname] = {
            "range": adef.get("range", "string"),
            "required": adef.get("required", False),
            "multivalued": adef.get("multivalued", False),
            "description": adef.get("description", ""),
        }

    # Slots referenced by name
    slot_usage = cls_def.get("slot_usage") or {}
    for sname in cls_def.get("slots") or []:
        base = all_slots.get(sname, {})
        override = slot_usage.get(sname, {})
        if not isinstance(base, dict):
            continue
        merged = {**base, **(override if isinstance(override, dict) else {})}
        props[sname] = {
            "range": merged.get("range", "string"),
            "required": merged.get("required", False),
            "multivalued": merged.get("multivalued", False),
            "description": merged.get("description", ""),
        }

    return props


def resolve_inheritance(
    cls_name: str, classes: dict, slots: dict, cache: dict
) -> dict[str, dict]:
    """Recursively resolve all inherited properties for a class."""
    if cls_name in cache:
        return cache[cls_name]

    cls_def = classes.get(cls_name, {})
    if not isinstance(cls_def, dict):
        cache[cls_name] = {}
        return {}

    parent = cls_def.get("is_a", "")
    if parent and parent in classes:
        inherited = dict(resolve_inheritance(parent, classes, slots, cache))
    else:
        inherited = {}

    own = resolve_slots(cls_def, slots)
    merged = {**inherited, **own}
    cache[cls_name] = merged
    return merged


def _camel_to_parts(name: str) -> list[str]:
    """Split CamelCase into lowercase parts. e.g. 'ResourceConcernLink' -> ['resource', 'concern', 'link']."""
    import re
    return [p.lower() for p in re.findall(r"[A-Z][a-z]*", name)]


def classify_edge(name: str, props: dict, cls_def: dict) -> dict | None:
    """Determine if a class is an edge type. Returns edge info or None."""
    is_link = name.endswith("Link") or name == "TopicEdge" or name == "TopicClosure"
    parent = cls_def.get("is_a", "")
    if parent == "QualifiedLink":
        is_link = True

    if not is_link:
        return None

    # Collect foreign-key fields and non-fk properties
    skip = {"id", "created_by", "created_at", "created_on"}
    fk_fields = []  # (field_name, prop_def) for *_id / source_* / target_* fields
    edge_props = {}

    for pname, pdef in props.items():
        if pname in skip:
            continue
        if pname.endswith("_id") or pname.startswith("source_") or pname.startswith("target_"):
            fk_fields.append((pname, pdef))
        else:
            edge_props[pname] = pdef

    source_fields = []
    target_fields = []

    # 1. Check for explicit edge_role annotations (future LinkML convention)
    for fname, fdef in fk_fields:
        role = (fdef.get("annotations") or {}).get("edge_role", "")
        if role == "source":
            source_fields.append(fname)
        elif role == "target":
            target_fields.append(fname)

    # 2. Fields with source_*/target_* prefix are unambiguous
    if not source_fields or not target_fields:
        for fname, _ in fk_fields:
            if not source_fields and fname.startswith("source_"):
                source_fields.append(fname)
            elif not target_fields and fname.startswith("target_"):
                target_fields.append(fname)

    # 3. For tree edges: parent/ancestor → source, child/descendant → target
    if not source_fields or not target_fields:
        for fname, _ in fk_fields:
            if not source_fields and fname in ("parent_id", "ancestor_id"):
                source_fields.append(fname)
            elif not target_fields and fname in ("child_id", "descendant_id"):
                target_fields.append(fname)

    # 4. Infer from class name: FooBarLink → foo_id is source, bar_id is target
    if (not source_fields or not target_fields) and len(fk_fields) >= 2:
        parts = _camel_to_parts(name)
        # Remove trailing "Link", "Edge", "Closure"
        parts = [p for p in parts if p not in ("link", "edge", "closure")]

        if len(parts) >= 2:
            source_hint = parts[0]  # e.g. "resource" from ResourceConcernLink
            target_hint = parts[1]  # e.g. "concern"
            remaining = list(fk_fields)
            # Match source (only if not already found)
            if not source_fields:
                for fname, fdef in fk_fields:
                    if fname.startswith(source_hint):
                        source_fields.append(fname)
                        remaining = [(f, d) for f, d in remaining if f != fname]
                        break
            # Match target (only if not already found)
            if not target_fields:
                for fname, fdef in fk_fields:
                    if fname.startswith(target_hint) and fname not in source_fields:
                        target_fields.append(fname)
                        remaining = [(f, d) for f, d in remaining if f != fname]
                        break
            # Any unmatched fk fields become edge properties
            for fname, fdef in remaining:
                if fname not in source_fields and fname not in target_fields:
                    edge_props[fname] = fdef

    # 5. Final fallback: positional — first fk is source, second is target
    if not source_fields and not target_fields:
        if len(fk_fields) >= 2:
            source_fields = [fk_fields[0][0]]
            target_fields = [fk_fields[1][0]]
        elif len(fk_fields) == 1:
            source_fields = [fk_fields[0][0]]

    return {
        "source_fields": source_fields,
        "target_fields": target_fields,
        "properties": edge_props,
        "parent": parent,
        "description": cls_def.get("description", ""),
    }


def build_manifest(schema: dict) -> dict:
    classes = schema.get("classes", {})
    slots = schema.get("slots", {})
    enums = schema.get("enums", {})

    inheritance_cache: dict[str, dict] = {}
    node_types = {}
    edge_types = {}
    abstract_types = {}

    for name, cls_def in classes.items():
        if not isinstance(cls_def, dict):
            continue

        is_abstract = cls_def.get("abstract", False)
        all_props = resolve_inheritance(name, classes, slots, inheritance_cache)
        parent = cls_def.get("is_a", "")

        # Try to classify as edge
        edge_info = classify_edge(name, all_props, cls_def)

        if edge_info is not None:
            edge_types[name] = edge_info
        elif is_abstract:
            abstract_types[name] = {
                "parent": parent,
                "own_properties": resolve_slots(cls_def, slots),
                "description": cls_def.get("description", ""),
            }
        else:
            # Separate properties into scalar props vs relationships (refs to other classes)
            scalar_props = {}
            relationships = {}
            for pname, pdef in all_props.items():
                range_type = pdef.get("range", "string")
                if range_type in classes:
                    relationships[pname] = {
                        "target": range_type,
                        "multivalued": pdef.get("multivalued", False),
                        "description": pdef.get("description", ""),
                    }
                else:
                    scalar_props[pname] = pdef
            node_types[name] = {
                "parent": parent,
                "properties": scalar_props,
                "relationships": relationships,
                "description": cls_def.get("description", ""),
            }

    # Extract enums as simple value lists
    enum_values = {}
    for ename, edef in enums.items():
        if isinstance(edef, dict):
            vals = edef.get("permissible_values", {})
            enum_values[ename] = {
                "description": edef.get("description", ""),
                "values": list(vals.keys()) if isinstance(vals, dict) else [],
            }

    return {
        "_meta": {
            "source": schema.get("name", ""),
            "version": schema.get("version", ""),
            "title": schema.get("title", ""),
            "generated_from": "tools/linkml-to-graph-manifest.py",
        },
        "node_types": node_types,
        "edge_types": edge_types,
        "abstract_types": abstract_types,
        "enums": enum_values,
    }


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <schema.yaml> <output.json>", file=sys.stderr)
        sys.exit(1)

    schema_path = sys.argv[1]
    output_path = sys.argv[2]

    schema = load_schema(schema_path)
    manifest = build_manifest(schema)

    with open(output_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Print summary
    print(f"Node types:    {len(manifest['node_types'])}")
    print(f"Edge types:    {len(manifest['edge_types'])}")
    print(f"Abstract:      {len(manifest['abstract_types'])}")
    print(f"Enums:         {len(manifest['enums'])}")
    print(f"Written to:    {output_path}")


if __name__ == "__main__":
    main()
