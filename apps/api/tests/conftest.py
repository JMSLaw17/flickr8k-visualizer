"""Helpers shared by the backend test modules."""

import json
from pathlib import Path

from flickr8k_visualizer.dataset_lock import load_dataset_lock


def write_prepared_identity(data_dir: Path, *, ready: bool = True) -> None:
    """Write a manifest and ready marker that match the tracked dataset lock."""
    dataset_lock = load_dataset_lock()
    manifest = {
        "dataset": {
            "repo_id": dataset_lock.repo_id,
            "revision": dataset_lock.revision,
        },
        "shards": [
            {
                "path": shard.repo_path,
                "split": shard.split,
                "size_bytes": shard.size_bytes,
                "sha256": shard.sha256,
                "row_count": shard.row_count,
            }
            for shard in dataset_lock.shards
        ],
    }
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if ready:
        (data_dir / ".ready").write_text(f"{dataset_lock.revision}\n", encoding="utf-8")
