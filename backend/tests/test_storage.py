from pathlib import Path

import pytest

from app.storage.filesystem import FilesystemObjectStorage


def test_storage_rejects_path_traversal(tmp_path: Path) -> None:
    storage = FilesystemObjectStorage(tmp_path)
    with pytest.raises(ValueError):
        storage.path_for("../../outside.h5")


def test_storage_resolves_object_key_inside_root(tmp_path: Path) -> None:
    storage = FilesystemObjectStorage(tmp_path)
    path = storage.path_for("recordings/patient-1/data.h5")
    assert path.parent == (tmp_path / "recordings/patient-1").resolve()
