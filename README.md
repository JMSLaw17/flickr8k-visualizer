# Flickr8k Visualizer

A local-first browser for inspecting the Flickr8k computer vision dataset: a React frontend, a FastAPI backend, and a one-time ingestion command that turns the pinned source Parquet files into local images, thumbnails, and SQLite metadata.

After preparation, the running application does not contact Hugging Face or any other remote service.

## Features

- **Browse**: exact caption search across all five captions with matching text
  highlighted, a paginated thumbnail gallery with split filtering, and a detail
  drawer showing every caption and the stored image metadata.
- **Overview**: sample counts by split, the caption-length distribution, common
  caption terms, image width/height distributions, and the aspect-ratio
  distribution. Every chart value links to the gallery filtered to the matching
  samples, so the shape of the dataset is always one click from the underlying
  images.
- **Data quality**: exact-duplicate groups detected by content SHA-256, the
  number of affected images, cross-split duplicate groups highlighted
  separately, and one-click access to each duplicate's detail view.

## Prerequisites

- Python 3.11 or newer
- [uv](https://docs.astral.sh/uv/)
- Node.js 20.19+, 22.13+, or 24+
- About 3 GB of free disk space while preparing the dataset

The repository pins Node 24 in `.nvmrc`. With `nvm`, activate it before installing dependencies:

```bash
nvm install
nvm use
```

## Setup

Install the frontend and backend dependencies:

```bash
npm install
uv sync --project apps/api --extra dev
```

Download and prepare Flickr8k. This downloads the four Parquet shards from the pinned dataset revision, verifies their checksums, extracts the original images, creates thumbnails, and builds the SQLite catalog. The downloaded Parquet files are removed only after ingestion succeeds.

```bash
npm run prepare:data
```

Prepared data is stored under `data/flickr8k/` and is intentionally ignored by Git. The command is idempotent: if the pinned revision is already prepared, it exits without downloading it again.

Start both development servers:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend development server proxies API and media requests to FastAPI at `http://localhost:8000`.

## Verification

```bash
npm test
npm run lint
npm run build
```

## Data layout

```text
data/flickr8k/
├── images/                 # Exact image bytes extracted from Parquet
├── thumbnails/             # Locally generated gallery thumbnails
├── flickr8k.sqlite3        # Samples, captions, dimensions, splits, paths, hashes
├── manifest.json           # Source revision, shard checksums, and ingestion summary
└── .ready                  # Written last when the database and manifest are publishable
```

The dataset repository, full commit revision, shard paths, byte sizes, SHA-256
checksums, and expected row counts are pinned in the tracked
[`datasets/flickr8k.lock.json`](datasets/flickr8k.lock.json). The preparation
command reads this lock file directly and rejects prepared data that does not
match it. Updating the dataset therefore requires an explicit lock-file change
and `--force` when replacing an existing local preparation. Sample IDs use the
original Flickr filename when present, so they do not depend on Parquet row
positions.

`content_sha256` is SHA-256 over the exact encoded bytes embedded in the source Parquet image cell. It is computed while those bytes are already in memory during ingestion, before image decoding or thumbnail generation. The definition is intentionally byte-exact: two differently encoded files with identical decoded pixels are not the same exact-duplicate group.

Stored width and height are the display dimensions after applying the image's
EXIF orientation, matching browser rendering and generated thumbnails. Original
files remain byte-for-byte copies of the source images.

The hash column has a non-unique SQLite index. After all samples are inserted, ingestion materializes one row per repeated hash in `duplicate_groups`. Exact-duplicate members are available with a direct join:

```sql
SELECT duplicate_groups.content_sha256, samples.id, samples.source_id
FROM duplicate_groups
JOIN samples USING (content_sha256)
ORDER BY duplicate_groups.content_sha256, samples.id;
```

## Configuration

Set `FLICKR8K_DATA_DIR` to use a data directory other than `data/flickr8k`:

```bash
FLICKR8K_DATA_DIR=/absolute/path/to/flickr8k npm run prepare:data
FLICKR8K_DATA_DIR=/absolute/path/to/flickr8k npm run dev
```

To replace an existing prepared dataset explicitly, run:

```bash
npm run prepare:data -- --force
```

## Monorepo structure

- `apps/web`: React and TypeScript frontend
- `apps/api`: FastAPI application, ingestion command, and backend tests
- `datasets`: tracked dataset revisions and shard integrity metadata
