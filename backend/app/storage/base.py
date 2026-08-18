from abc import ABC, abstractmethod
from pathlib import Path


class ObjectStorage(ABC):
    """Interface used by the application for large ECG/report objects."""

    @abstractmethod
    def path_for(self, object_key: str) -> Path:
        raise NotImplementedError
