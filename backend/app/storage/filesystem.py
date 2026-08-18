from pathlib import Path

from app.storage.base import ObjectStorage


class FilesystemObjectStorage(ObjectStorage):
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, object_key: str) -> Path:
        candidate = (self.root / object_key).resolve()
        if self.root not in candidate.parents and candidate != self.root:
            raise ValueError("Invalid object key")
        return candidate
