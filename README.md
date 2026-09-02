# Flickr8k Visualizer

A local-first browser for inspecting the Flickr8k computer vision dataset: a React frontend, a FastAPI backend, and a one-time ingestion command that turns the pinned source Parquet files into local images, thumbnails, and SQLite metadata.

After preparation, the running application does not contact Hugging Face or any other remote service.

## Features

- **Browse**: exact caption search across all five captions with matching text
  highlighted, a paginated thumbnail gallery with split filtering, and a detail
  drawer showing every caption and the stored image metadata. Each card shows
  the split, the source filename, and a duplicate marker when the image is
  byte-identical to another sample. Gallery state and
  open samples have direct, shareable URLs. Without visual ranking, results stay
  in ascending sample-ID order and previous/next navigation follows the complete
  filtered result set.
- **Visual ranking**: rank every image in the current filter scope by similarity
  to a natural-language description ("a dog running through snow"). Ranking is
  composable with literal caption search, exact-term search, and every other
  filter, runs locally with the pinned CLIP model, and shows each result's raw
  cosine similarity score.
- **Overview**: sample counts by split, the most common exact image sizes with
  a summary of the remaining long tail, the aspect-ratio distribution, the
  caption-length distribution, and common caption terms. The overview has the
  same caption search and split controls as the gallery and accepts the same
  filters, and the navigation keeps them when switching pages, so any subset
  can be compared against the whole dataset. Each split, listed common size,
  ratio, caption-length, and term value links to the matching gallery; the
  remaining dimension long tail is summarized without listing every rare size.
- **Data quality**: exact-duplicate groups detected by content SHA-256, the
  number of affected images, cross-split duplicate groups highlighted
  separately, and one-click access to each duplicate's detail view. This
  section always covers the whole dataset, independent of the overview scope.

For example, [`/?q=snow&rank=a+dog+jumping&split=train`](http://localhost:5173/?q=snow&rank=a+dog+jumping&split=train)
filters the training split to captions containing “snow,” then ranks those same
samples by visual similarity to “a dog jumping.”

Keyboard shortcuts: press `/` to focus caption search, press Escape to close the
detail drawer, and use the Left and Right Arrow keys to move between samples in
the detail drawer.

## Prerequisites

- CPython 3.11–3.14 on Apple silicon macOS 14+, Windows x86-64, or Linux
  x86-64/ARM64 with glibc 2.28+ (the platforms covered by the locked PyTorch
  wheels)
- [uv](https://docs.astral.sh/uv/) 0.5.11 or newer (older releases cannot read
  the lock file; the requirement is enforced via `tool.uv.required-version`)
- On Windows, Git symlink support — enable Developer Mode (or run Git as a user
  with the symlink privilege) and clone with `git config core.symlinks true`.
  The tracked `datasets/flickr8k.lock.json` and `models/clip.lock.json` are
  symlinks and check out as plain text files otherwise
- Node.js 20.19+, 22.13+, or 24+
- About 4 GB of free disk space while preparing the dataset and the visual
  ranking model, plus about 1 GB for the installed Python dependencies (CLIP
  inference is CPU-only, and the lock file pins PyTorch's CPU build on Linux,
  so no CUDA packages are downloaded)

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

Download and prepare Flickr8k. This runs two stages:

1. **Dataset**: downloads the four Parquet shards from the pinned dataset
   revision, verifies their checksums, extracts the original images, creates
   thumbnails, and builds the SQLite catalog. The downloaded Parquet files are
   removed only after ingestion succeeds.
2. **Visual ranking**: downloads the pinned CLIP model (about 608 MB) into
   `data/flickr8k/visual-search/model/`, verifies each file's checksum, and
   embeds every image into a local index (a few minutes on CPU).

```bash
npm run prepare:data
```

Prepared data is stored under `data/flickr8k/` and is intentionally ignored by Git. The command is idempotent: each stage that is already prepared is skipped without downloading anything again. If the visual stage fails (for example, the model download is interrupted), browsing still works, requests with visual ranking return a clear 503, and rerunning the command retries only the visual stage.

To try browsing first without downloading the model, prepare only the dataset;
visual ranking returns a 503 until the full command runs:

```bash
npm run prepare:data -- --skip-visual
```

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
├── flickr8k.sqlite3        # Samples, captions, dimensions, splits, paths, hashes,
│                           # and the clip_embeddings visual index
├── manifest.json           # Source revision, shard checksums, and ingestion summary
├── .ready                  # Written last when the database and manifest are publishable
└── visual-search/
    ├── model/              # Pinned CLIP model files, verified by checksum
    ├── manifest.json       # Model identity, dataset revision, and embedding summary
    └── .ready              # Written last when the visual index is publishable
```

On a fresh preparation with `--skip-visual`, the `visual-search/` directory and
the `clip_embeddings` table are absent until the visual stage runs.

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

## Visual ranking

Visual ranking first applies the current caption query, exact-term, split, and
numeric filters. It then encodes the ranking description with
[`openai/clip-vit-base-patch32`](https://huggingface.co/openai/clip-vit-base-patch32)
and orders the filtered set by exact cosine similarity against the image
embeddings stored during preparation — a brute-force dot product over
L2-normalized 512-dimensional vectors, with no approximate index. Each query
encodes only its text; images are embedded once, when the index is built.
Ranking never changes which samples match. Ties are broken by ascending sample
ID, so a given description always returns the same order.

The model is pinned in the tracked
[`models/clip.lock.json`](models/clip.lock.json): repository, full commit
revision, the exact files to download (only the safetensors weight plus the
configuration and tokenizer files, not the other framework formats), each
file's byte size and SHA-256 checksum, the embedding dimension, and a
preprocessing version. Preparation downloads these files into
`data/flickr8k/visual-search/model/` and rejects anything that does not match
the lock. After preparation, queries run entirely locally.

Embeddings are stored per sample in the `clip_embeddings` SQLite table as
little-endian float32 blobs. Images are decoded with EXIF orientation applied
and converted to RGB before encoding, matching how the app displays them.

**Interpreting scores**: results show the raw CLIP cosine similarity (for
example `0.284`). Higher values rank as more similar; the score is not a
percentage or a confidence. Scores are only comparable within a single query —
a vague query can score its top result higher than a precise query scores its
median. Query text is tokenized within CLIP's 77-token context
window; typical queries under the 200-character input limit fit comfortably,
and longer token sequences are truncated. CLIP has known limitations — it struggles with
counting and fine-grained recognition, it was trained primarily on English
text, and it reflects the social biases of its web training data (see the
[CLIP model card](https://github.com/openai/CLIP/blob/main/model-card.md)).
Treat visual ranking as a research aid, not ground truth.

The detail drawer follows the active ordering: with a `rank` parameter,
previous/next step through the ranked result set and the drawer shows the
sample's own similarity score; without one, they follow stable-ID order. Both
traverse the complete filtered result set, not just the visible page.

The default test suite never loads or downloads the real model. After
preparation, an optional real-model smoke test is available:

```bash
FLICKR8K_REAL_MODEL=1 npm run test:api -- apps/api/tests/test_visual_smoke.py
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
- `models`: tracked model revisions and file integrity metadata
