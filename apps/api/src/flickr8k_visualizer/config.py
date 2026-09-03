from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_DATA_DIR = REPOSITORY_ROOT / "data" / "flickr8k"


@dataclass(frozen=True, slots=True)
class Settings:
    data_dir: Path = DEFAULT_DATA_DIR
    database_path: Path = DEFAULT_DATA_DIR / "flickr8k.sqlite3"
    manifest_path: Path = DEFAULT_DATA_DIR / "manifest.json"
    cors_origins: tuple[str, ...] = ("http://localhost:5173",)

    @property
    def ready_path(self) -> Path:
        return self.data_dir / ".ready"

    @property
    def visual_search_dir(self) -> Path:
        return self.data_dir / "visual-search"

    @property
    def model_dir(self) -> Path:
        return self.visual_search_dir / "model"

    @property
    def visual_manifest_path(self) -> Path:
        return self.visual_search_dir / "manifest.json"

    @property
    def visual_ready_path(self) -> Path:
        return self.visual_search_dir / ".ready"

    @classmethod
    def for_data_dir(cls, data_dir: Path) -> Settings:
        """Settings for a data directory; the one place its layout is spelled out."""
        data_dir = data_dir.expanduser().resolve()
        return cls(
            data_dir=data_dir,
            database_path=data_dir / "flickr8k.sqlite3",
            manifest_path=data_dir / "manifest.json",
        )

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = _path_from_env("FLICKR8K_DATA_DIR", DEFAULT_DATA_DIR)
        database_path = _path_from_env(
            "FLICKR8K_DATABASE_PATH", data_dir / "flickr8k.sqlite3"
        )
        manifest_path = _path_from_env(
            "FLICKR8K_MANIFEST_PATH", data_dir / "manifest.json"
        )
        origins = tuple(
            origin.strip()
            for origin in os.getenv(
                "FLICKR8K_CORS_ORIGINS", "http://localhost:5173"
            ).split(",")
            if origin.strip()
        )

        return cls(
            data_dir=data_dir,
            database_path=database_path,
            manifest_path=manifest_path,
            cors_origins=origins,
        )


def _path_from_env(name: str, default: Path) -> Path:
    value = os.getenv(name)
    return Path(value).expanduser().resolve() if value else default
