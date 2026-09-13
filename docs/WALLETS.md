# Global wallet explorer

`/wallets` queries the full wallet index, not just the rows displayed in the browser.

## Filters and pagination

`GET /api/wallets` accepts:

- `q`: a case-sensitive Bitcoin address or address prefix.
- `sort`: `address-asc`, `address-desc`, `hops-asc`, or `hops-desc`.
- `minHops`, `maxHops`: optional inclusive, nonnegative whole-number bounds.
- `limit`: page size, up to 200.
- `cursor`: an opaque continuation token from the preceding response. Keep the same filters and sort when using it.

The server applies filters before ordering and pagination. Do not filter or re-sort a returned page to simulate a global result. Invalid query values or a cursor belonging to different filters return 400.

Wallet data changes as historical synchronization progresses. Each response uses a consistent database view; subsequent pages can reflect newly confirmed blocks. The browser restarts pagination when filters change and refreshes periodically while visible, preserving the selected filters.

## Automatic index updates

Authoritative compact wallet records remain `a:<address>`. The additional ordered index stores only `h:<16-digit-hop-count>:<address>` with a small marker value. It does not store transaction history, paths, or spent outputs.

Every confirmed sync window writes all of these atomically:

1. Live UTXO additions and spent-output deletions.
2. New or improved shortest-hop wallet records.
3. Removal of previous hop-index entries and insertion of their replacements.
4. The block checkpoint and counters.

No periodic full rebuild is needed. New wallets and hop improvements become searchable as the checkpoint is confirmed, normally every 100 blocks.

## One-time backfill

An existing database needs a one-time pass over its compact wallet records to populate the new index. The scan is bounded, resumable and runs alongside blockchain sync. It does not rescan Bitcoin blocks or delete the taint database.

Each backfill chunk reads the current wallet records and writes index entries plus its own continuation marker under the same write lock used by sync commits. It does not retain a stale snapshot across chunks. This prevents an old hop value from being reintroduced after sync has improved it.

Until the initial index is complete, requests that require it return 503 with index progress rather than misleading partial global results. Plain address browsing/search remains available. The UI retries while showing indexing progress. `/api/sync-status` exposes the wallet index state alongside blockchain sync state.

The initial pass adds disk I/O on the NAS. `INDEX_BATCH_SIZE` defaults to 2000 rows (environment bounds 100–50000); `INDEX_PAUSE_MS` defaults to 100 ms between chunks (0–60000). Tune only with measured checkpoint and index progress. The server suggests a 30-second retry while preparing the index, avoiding exhaustion of the general API rate limit. Normal visible-page results refresh every 60 seconds with the selected filters preserved.

Its progress and blockchain checkpoint must both be monitored. Never mark an incomplete index ready or remove data to accelerate initialization. Queries seek occupied hop buckets and merge their address-ordered heads; they do not require the user to traverse empty pages of a full-database scan. A defensive 512-bucket/2000-step budget returns 422 with a narrowing suggestion rather than a partial result.
