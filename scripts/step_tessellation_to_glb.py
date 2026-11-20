from __future__ import annotations

import argparse
import re
from pathlib import Path

import numpy as np
import trimesh


COORD_RE = re.compile(
    r"#(?P<id>\d+)=COORDINATES_LIST\('[^']*',\s*(?P<count>\d+),\s*\(\((?P<body>.*?)\)\)\);",
    re.DOTALL,
)
FACE_RE = re.compile(
    r"TRIANGULATED_FACE\('[^']*',\s*#(?P<coord>\d+),\s*3\s*,.*?,\s*\(\((?P<idx>\d+)\s*,\s*(?P<idy>\d+)\s*,\s*(?P<idz>\d+)\)\)\);",
    re.DOTALL,
)


def parse_coord_tuple(raw: str) -> list[float]:
    return [float(part.replace("D", "E")) for part in raw.split(",")[:3]]


def load_tessellated_step(path: Path) -> trimesh.Trimesh:
    text = path.read_text(errors="ignore")
    coord_lists: dict[int, list[list[float]]] = {}

    for match in COORD_RE.finditer(text):
        coord_id = int(match.group("id"))
        tuples = re.findall(r"\(([^()]+)\)", f"({match.group('body')})")
        coords = [parse_coord_tuple(item) for item in tuples if item.strip()]
        if coords:
            coord_lists[coord_id] = coords

    vertices: list[list[float]] = []
    faces: list[list[int]] = []
    offsets: dict[int, int] = {}
    for coord_id, coords in coord_lists.items():
        offsets[coord_id] = len(vertices)
        vertices.extend(coords)

    for match in FACE_RE.finditer(text):
        coord_id = int(match.group("coord"))
        if coord_id not in offsets:
            continue
        offset = offsets[coord_id]
        # STEP tessellation indices are 1-based.
        face = [
            offset + int(match.group("idx")) - 1,
            offset + int(match.group("idy")) - 1,
            offset + int(match.group("idz")) - 1,
        ]
        if min(face) >= offset and max(face) < offset + len(coord_lists[coord_id]):
            faces.append(face)

    if not vertices or not faces:
        raise RuntimeError("No tessellated vertices/faces were found in the STEP file.")

    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    # STEP units in this file are millimeters. Convert to meters for the app.
    mesh.apply_scale(0.001)
    mesh.apply_translation(-mesh.bounds.mean(axis=0))
    mesh.apply_translation([0, 0, -mesh.bounds[0][2]])
    return mesh


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract tessellated STEP geometry into a GLB file.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    mesh = load_tessellated_step(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(args.output)
    print(f"vertices={len(mesh.vertices)} faces={len(mesh.faces)} bounds_m={mesh.bounds.tolist()}")
    print(f"wrote={args.output}")


if __name__ == "__main__":
    main()
