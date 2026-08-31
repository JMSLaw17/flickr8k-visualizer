# Repository Guide

## Purpose

This monorepo is a local web-based visualization tool for the Flickr8k dataset.

Prefer clear, modular code with the least complexity needed for the current
phase. Keep comments short and use them only when the reason is not obvious from
the code.

## Structure

- `apps/api`: FastAPI, SQLite access, ingestion, and Pytest
- `apps/web`: React, TypeScript, Vite, and Vitest
- `apps/web/src/dataset`: API calls, filters, and data formatting
- `apps/web/src/gallery`: gallery page and its components
- `apps/web/src/overview`: overview page, charts, and summaries
- `apps/web/src/detail`: sample drawer, links, and drawer routing
- `apps/web/src/shared`: UI and interaction code shared by features
- `apps/web/src/test`: shared test setup and cross-feature integration tests
- `datasets/flickr8k.lock.json`: tracked dataset revision and shard integrity metadata
- `models/clip.lock.json`: tracked visual-search model revision and file integrity metadata
- `data/flickr8k`: generated dataset artifacts; ignored by Git

## Commands

Use the Node version in `.nvmrc` (Node 24), a supported CPython 3.11–3.14
environment through `uv`, and `npm` from the repository root. Do not add nested
lockfiles. Run commands from the repository root unless a command says
otherwise.

```bash
nvm install           # Install the pinned Node version if needed
nvm use               # Activate the pinned Node version
npm install           # Install frontend and root dependencies
uv sync --project apps/api --extra dev  # Install backend and test dependencies
npm run dev           # Start the API and frontend
npm run prepare:data  # Prepare the pinned dataset once
npm test              # Run backend and frontend tests
npm run lint          # Run Ruff, ESLint, and Stylelint
npm run lint:fix      # Apply safe automatic lint and format fixes
npm run build         # Type-check and build the frontend
```

## Validation

Validate every change before handing it off. Run the checks for every affected
area; when a change spans multiple areas, combine their checks.

| Change scope | Required validation |
| --- | --- |
| Backend Python | `npm run lint:api` and `npm run test:api` |
| Frontend TypeScript or React | `npm run lint:web`, `npm run test:web`, and `npm run build` |
| CSS or visual UI | `npm run lint:styles`, `npm run test:web`, `npm run build`, and a live browser check of the affected state |
| API contract | Backend and frontend lint/tests, plus `npm run build` |
| Ingestion, schema, IDs, hashes, or duplicate groups | `npm run lint:api`, `npm run test:api`, and focused synthetic-fixture coverage; run `npm run prepare:data` when the real ingestion path changes and local data is available |
| Visual search model, embeddings, or ranking | `npm run lint:api` and `npm run test:api` with synthetic vectors only; when the real model or index path changes and local data is available, also run `npm run prepare:data` and `FLICKR8K_REAL_MODEL=1 npm run test:api -- apps/api/tests/test_visual_smoke.py` |
| Cross-cutting configuration or dependencies | `npm run lint`, `npm test`, and `npm run build` |
| Documentation only | Verify links, paths, commands, and symlinks directly; code tests are not required unless the documentation change also alters executable configuration |

Add or update a focused regression test when behavior changes. Confirm error,
loading, empty, and retry paths when the affected code handles those states. Do
not treat `npm run lint:fix` as validation: after applying fixes, run the
non-mutating lint command again. Report any check that could not be run and why.
