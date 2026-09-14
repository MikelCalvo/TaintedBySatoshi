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

Wallet data changes as historical synchronization progresses. Each response uses a consistent database view; subsequent pages can reflect newly confirmed blocks. The browser restarts pagination when filters change and refreshes periodically while visible, preserving the selected filters. Page contents are not a frozen snapshot of the whole result set, and the API does not advertise an exact matching total.

## Query plans and read budget

Authoritative compact wallet records remain `a:<address>`. Hop order uses the derived `h:<16-digit-hop-count>:<address>` markers. Each listing request stays inside a 2000 iterator-read budget and hydrates at most one page of authoritative records (`getMany` of the returned rows only).

Typical plans:

- Address order without a hop filter seeks the `a:` prefix and reads `limit+1` keys.
- Hop order without an address prefix reads `limit+1` keys from the already-sorted `h:` range, including across more than 512 occupied hop counts.
- Address order with a narrow inclusive hop range merges a small number of hop buckets by address.
- Address order with a wide hop range scans `a:` keys and keeps rows whose stored hop count is in range.
- Hop order with an address prefix first probes a small bounded `a:` prefix. If that prefix is fully exhausted, the matches are sorted in memory. Otherwise the query walks occupied hop buckets lazily and seeks each bucket's prefix, instead of discovering every occupied hop count up front.

If a sparse cross-index filter cannot finish inside the read budget, the response may underfill or return no rows for that page. In that case `hasMore` remains true, `nextCursor` resumes after the last examined key or hop-bucket boundary, and `scanLimited` is set. That is not an empty result set. Do not treat a short page as proof that later pages are empty. The existing wallets UI auto-continues a few empty pages and then shows Continue searching.

Cursors stay scoped to the same sort, prefix, and hop bounds. Ordinary result cursors remain v1 keyset tokens. Scan progress may use a v2 hop-bucket boundary (`h:<16-digit-hop-count>:`) so a later page can resume after a finished degree without claiming a matching address. Cursors from a different prefix, sort, or hop range are rejected.

A 422 `WALLET_QUERY_TOO_BROAD` response is reserved for a query that cannot be executed safely; it is not returned merely because more than 512 hop counts exist.

## Automatic index updates

The additional ordered index stores only `h:<16-digit-hop-count>:<address>` with a small marker value. It does not store transaction history, paths, or spent outputs.

Every confirmed sync window writes all of these atomically:

1. Live UTXO additions and spent-output deletions.
2. New or improved shortest-hop wallet records.
3. Removal of previous hop-index entries and insertion of their replacements.
4. The block checkpoint and counters.

No periodic full rebuild is needed. New wallets and hop improvements become searchable as the checkpoint is confirmed, normally every 100 blocks.

## One-time backfill

An existing database needs a one-time pass over its compact wallet records to populate the new index. The scan is bounded, resumable and runs alongside blockchain sync. It does not rescan Bitcoin blocks or delete the taint database.

Each backfill chunk reads the current wallet records and writes index entries plus its own continuation marker under the same write lock used by sync commits. It does not retain a stale snapshot across chunks. This prevents an old hop value from being reintroduced after sync has improved it.

On restart, a valid completed index marker is restored before connecting to Bitcoin RPC. Existing wallet searches therefore remain available during an RPC outage; blockchain synchronization and readiness still report that outage. This restoration does not run a backfill or write wallet data. Missing or partial indexes still wait for seed/database initialization before backfilling.

Until the initial index is complete, requests that require it return 503 with index progress rather than misleading partial global results. Plain address browsing/search remains available. The UI retries while showing indexing progress. `/api/sync-status` exposes the wallet index state alongside blockchain sync state.

The initial pass adds disk I/O on the NAS. `INDEX_BATCH_SIZE` defaults to 2000 rows (environment bounds 100–50000); `INDEX_PAUSE_MS` defaults to 100 ms between chunks (0–60000). Tune only with measured checkpoint and index progress. The server suggests a 30-second retry while preparing the index, avoiding exhaustion of the general API rate limit. Normal visible-page results refresh every 60 seconds with the selected filters preserved.

Its progress and blockchain checkpoint must both be monitored. Never mark an incomplete index ready or remove data to accelerate initialization.
