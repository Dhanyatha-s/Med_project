from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Holter ECG Platform"
    environment: str = "development"
    api_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://holter:holter@localhost:5432/holter"
    data_root: Path = Path("data")
    object_storage_backend: str = "filesystem"
    object_storage_root: Path = Path("data/objects")
    max_ecg_window_seconds: int = 120

    model_config = SettingsConfigDict(env_file=".env", env_prefix="HOLTER_", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
