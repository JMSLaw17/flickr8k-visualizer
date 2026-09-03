# Flickr8k Visualizer

A local-first browser for inspecting the Flickr8k computer vision dataset: a React frontend, a FastAPI backend, and a one-time ingestion command that turns the pinned source Parquet files into local images, thumbnails, and SQLite metadata.

After preparation, the running application does not contact Hugging Face or any other remote service.

## Quick start

From a fresh clone, with Node 24 and `uv` installed (see Prerequisites):

```bash
git clone https://github.com/JMSLaw17/flickr8k-visualizer.git
cd flickr8k-visualizer
nvm use            # if you manage Node with nvm
npm run setup
npm run prepare:data
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173). `npm run setup`
installs both the frontend and backend dependencies, `npm run prepare:data`
downloads and prepares the dataset and model once (about 1.7 GB, a few minutes
on broadband plus about a minute of embedding on Apple silicon or a few on a
CPU-only machine), and `npm run dev` starts the API and the frontend. Each
step is explained under Setup in detail.

## Prerequisites

- **Node.js 24** (20.19+ and 22.13+ also work). The repository pins Node 24 in
  `.nvmrc`; with `nvm`, run `nvm install` then `nvm use` first.
- **[uv](https://docs.astral.sh/uv/) 0.5.11 or newer.** It manages the Python
  side entirely: `apps/api/.python-version` pins CPython 3.11, and `uv`
  downloads a managed build if none is installed. CPython 3.11–3.13 are the
  versions the lock file has wheels for.
- **Platform**: Apple silicon macOS 14+, Windows x86-64, or Linux x86-64/ARM64
  with glibc 2.28+, the platforms covered by the locked PyTorch and PyArrow
  wheels. CLIP inference runs on the Apple GPU through Metal when available
  and on the CPU otherwise; no CUDA packages are downloaded.
- **Disk**: about 2 GB under `data/flickr8k/` after preparation, roughly
  4 GB while it runs, plus about 1 GB for the Python dependencies.
- **On Windows**, Git symlink support: enable Developer Mode (or run Git as a
  user with the symlink privilege) and clone with
  `git config core.symlinks true`. `datasets/flickr8k.lock.json` and
  `models/clip.lock.json` are symlinks to the packaged copies and check out as
  plain text files otherwise; the app still works, but the tests that compare
  the tracked and packaged copies fail.

## Setup in detail

Three commands, run from the repository root.

**1. Install dependencies.** This runs `npm install` for the frontend and
`uv sync` for the backend; the two underlying commands can also be run
directly.

```bash
npm run setup
```

**2. Download and prepare the dataset.** This is a one-time step with two
stages, and it needs network access only while it runs:

1. **Dataset**: downloads the four Parquet shards (1.1 GB) from the pinned
   dataset revision, verifies their checksums, extracts the original images,
   creates thumbnails, and builds the SQLite catalog. The Parquet files are
   removed after ingestion succeeds.
2. **Visual ranking**: downloads the pinned CLIP model (608 MB) into
   `data/flickr8k/visual-search/model/`, verifies each file, and embeds every
   image into a local index.

```bash
npm run prepare:data
```

Prepared data lives under `data/flickr8k/`, which Git ignores. What to expect: the download takes a few minutes on a typical broadband
connection, and the embedding pass takes about a minute on Apple silicon,
where it runs on the GPU, or a few minutes on a CPU-only machine, logging
progress every 512 images. Large downloads log their
progress and transfer rate at each quarter, so a slow link is visible. If the
rate is far below your connection's, check for a VPN: some VPN endpoints
throttle downloads from Hugging Face to a small fraction of the normal speed.

The command is safe to interrupt and rerun. Each finished stage is skipped,
each verified download is reused, and only the unfinished shard is fetched
again. If the visual stage fails, browsing still works, ranking requests
return a clear 503, and rerunning retries only that stage. To browse before
downloading the model, prepare the dataset alone; ranking stays disabled with a
"Not prepared" hint until the full command runs:

```bash
npm run prepare:data -- --skip-visual
```

**3. Start the app.** This starts the API on port 8000 and the frontend on
port 5173, which proxies API and media requests to the API.

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Starting the app before
preparing the data is fine: the pages explain what to run.

## Verification

```bash
npm test
npm run lint
npm run build
```

## Features

- **Browse**: exact caption search across all five captions with matching
  text highlighted on the cards and in the detail drawer, a paginated
  thumbnail gallery with split filtering, and a detail drawer showing every
  caption and the stored image metadata. While a phrase or exact-term filter
  is active, each card lists up to two captions containing it, with the
  text highlighted, and the drawer marks them; with only a caption-length
  filter, the captions in range are listed and marked instead. Each card
  shows the split, the source filename, and a duplicate marker when the image
  is byte-identical to another sample. Every active filter, including ranges
  chosen from Overview charts, appears as a removable chip. Gallery state and
  open samples have direct, shareable URLs. Without visual ranking, results
  stay in ascending sample-ID order and previous/next navigation follows the
  complete filtered result set.
- **Visual ranking**: rank every image in the current filter scope by similarity
  to a natural-language description ("a dog running through snow"). Ranking is
  composable with literal caption search, exact-term search, and every other
  filter, runs locally with the pinned CLIP model, and shows each result's raw
  cosine similarity score. From any sample's detail drawer, **Find similar
  images** ranks the same scope by similarity to that image instead, using
  its stored embedding, with the reference image itself first at 1.000 when
  it is in scope, so near-duplicate and leakage checks are one click: open a
  test image, find similar images, and narrow to the training split.
- **Overview**: sample counts by split, the most common exact image sizes with
  a summary of the remaining long tail, the aspect-ratio distribution, the
  caption-length distribution with a count of very short captions, and common
  caption terms. The overview has the same caption search and split controls
  as the gallery and accepts the same filters, and the navigation keeps filters
  and ranking when switching pages, so any subset can be compared against the
  whole dataset. The split chart ignores the selected split on purpose, so a
  caption search can be compared across train, validation, and test. Each
  split, listed common size, ratio, caption-length, and term value links to
  the matching gallery; the remaining dimension long tail is summarized
  without listing every rare size.
- **Data quality**: exact-duplicate groups detected by content SHA-256, the
  number of affected images, cross-split duplicate groups highlighted
  separately, and one-click access to each duplicate's detail view. This
  section always covers the whole dataset, independent of the overview scope.

For example, [`/?q=snow&rank=a+dog+jumping&split=train`](http://localhost:5173/?q=snow&rank=a+dog+jumping&split=train)
filters the training split to captions containing “snow,” then ranks those same
samples by visual similarity to “a dog jumping.” Replacing the description with
a sample ID, as in [`/?similar_to=2851198725_37b6027625&split=train`](http://localhost:5173/?similar_to=2851198725_37b6027625&split=train),
ranks the training split by similarity to that image, which is how to check
whether a test image has near-duplicates in training. `rank` and `similar_to`
are two forms of one ordering: the API rejects a request with both, and a URL
carrying both is read as `similar_to`.

Dataset-wide near-duplicate detection is deliberately left as future work: it
needs an all-pairs similarity pass at preparation time and a threshold checked
against real near-duplicates, since CLIP scores different photos of the same
subject highly too. Similar-image ranking is the on-demand version of that audit.

Keyboard shortcuts: press `/` to focus caption search on either page, press
Escape to close the detail drawer, and use the Left and Right Arrow keys to
move between samples in the detail drawer.

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
[`datasets/flickr8k.lock.json`](datasets/flickr8k.lock.json), a symlink to the
copy packaged with the API. The preparation command reads that lock file and
rejects prepared data that does not match it. Updating the dataset therefore
requires an explicit lock-file change and `--force` when replacing an existing
local preparation. Sample IDs are the original Flickr filename without its
extension when present, so they do not depend on Parquet row positions.

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
numeric filters. It then orders the filtered set by exact cosine similarity
between a query vector and the image embeddings stored during preparation — a
brute-force dot product over L2-normalized 512-dimensional vectors, with no
approximate index. The query vector is either a ranking description encoded
with [`openai/clip-vit-base-patch32`](https://huggingface.co/openai/clip-vit-base-patch32)
(`rank`) or the stored embedding of a reference sample (`similar_to`), which
needs no model inference at all. Images are embedded once, when the index is
built. Ranking never changes which samples match. Ties are broken by ascending
sample ID, so a given query always returns the same order.

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
Encoding runs in batches of 128 on the Apple GPU through Metal when PyTorch
can use it and on the CPU otherwise; the two agree to within floating-point
noise, so rankings do not depend on the machine that built the index.

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

The detail drawer follows the active ordering: with a `rank` or `similar_to`
parameter, previous/next step through the ranked result set and the drawer
shows the sample's own similarity score; without one, they follow stable-ID
order. Both traverse the complete filtered result set, not just the visible
page.

The default test suite never loads or downloads the real model. After
preparation, an optional real-model smoke test is available:

```bash
FLICKR8K_REAL_MODEL=1 npm run test:api -- apps/api/tests/test_visual_smoke.py
```

## Configuration

Set `FLICKR8K_DATA_DIR` to use a data directory other than `data/flickr8k`;
the preparation command also accepts it as `--data-dir`:

```bash
FLICKR8K_DATA_DIR=/absolute/path/to/flickr8k npm run prepare:data
FLICKR8K_DATA_DIR=/absolute/path/to/flickr8k npm run dev
```

`FLICKR8K_DEVICE` forces the device CLIP runs on: `cpu`, `mps`, or `cuda`,
the last only with a CUDA-enabled PyTorch, which the lock file does not
install. By default the Apple GPU is used when PyTorch can see one, else the
CPU.
`FLICKR8K_DATABASE_PATH` and `FLICKR8K_MANIFEST_PATH` override the two files
individually, and `FLICKR8K_CORS_ORIGINS` is a comma-separated list of allowed
frontend origins (default `http://localhost:5173`).

To replace an existing prepared dataset explicitly, run:

```bash
npm run prepare:data -- --force
```

## Monorepo structure

- `apps/web`: React and TypeScript frontend. `src` is organized by feature:
  `gallery`, `overview`, and `detail` pages, `dataset` for the API client and
  filter model, and `shared` for controls used by more than one page
- `apps/api`: FastAPI application, ingestion command, and backend tests
- `datasets`: tracked dataset revisions and shard integrity metadata
- `models`: tracked model revisions and file integrity metadata
