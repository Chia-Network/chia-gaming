"""Copy versioned player assets from earlier release archives into a Pages build."""

import json
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath
from shutil import copyfileobj


def retain_bundle(player: Path, archive_path: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        with archive.extractfile("./build-meta.json") as metadata:
            base_path = json.load(metadata)["basePath"]
        if not re.fullmatch(r"/app/[0-9]+/", base_path):
            raise ValueError(f"Invalid player basePath: {base_path!r}")
        bundle = PurePosixPath(base_path.lstrip("/"))
        files = []
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path == bundle or not path.is_relative_to(bundle):
                continue
            if ".." in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError(f"Unsupported bundle member: {member.name}")
            if member.isfile():
                files.append((path, member))
        if not files:
            raise ValueError(f"No player assets found under {base_path}")

        # A versioned URL must always serve the same build.
        (player / bundle).mkdir()
        for path, member in files:
            target = player / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                copyfileobj(source, output)


if __name__ == "__main__":
    player = Path(sys.argv[1])
    for name in sys.argv[2:]:
        try:
            retain_bundle(player, Path(name))
        except (KeyError, OSError, TypeError, ValueError, tarfile.TarError) as error:
            sys.exit(f"Could not retain player assets from {name}: {error}")
