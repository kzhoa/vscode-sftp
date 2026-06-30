# Pitch: Connection Pool Lifecycle Management

> **Status: Implemented**

## Problem

`src/core/remoteFs.ts` originally maintained a module-level connection pool keyed by a fragile string hash. That design had several structural problems:

- no explicit ownership
- no bounded lifecycle on config removal or extension shutdown
- no idle reclamation
- no capacity control
- collision-prone connection identity

It also coupled connection reuse to implicit global state rather than to a first-class runtime contract.

## Goal

Replace the implicit module-level pool with an application-owned `ConnectionPool` and move remote connection lifetime under explicit composition and service lifecycle control.

## What Landed

### 1. `ConnectionPool` became a first-class runtime object

`src/core/connectionPool.ts` now owns pooled remote connections and is created in the composition root.

Implemented capabilities:

- stable connection identity derived from a normalized connection spec
- shared connection reuse for identical remote specs
- observer fan-out for connection lifecycle events
- idle TTL for ordinary post-use release
- bounded pool capacity with FIFO waiters and acquire timeout
- explicit pool disposal on extension deactivation

### 2. Connection ownership moved to the composition layer

`app.ts` now owns a single `ConnectionPool` instance, and `serviceManager` injects it into each `FileService`.

This removed the previous module-global ownership model and made startup/shutdown sequencing explicit:

- create pool during activation
- pass pool to services through constructor dependencies
- dispose services first on shutdown
- dispose the pool after service teardown

### 3. `FileService` moved to operation-scoped remote access

The original design draft assumed long-lived `FileService` references into the pool. That approach was implemented initially, then corrected during review because it would pin pool capacity for the entire runtime of a service after first use.

The implemented final model is stricter:

- `FileService` exposes `withRemoteFileSystem(...)`
- each remote operation acquires a lease, runs within the callback scope, and releases immediately afterward
- `FileService` no longer exposes a public API that returns a long-lived pooled remote filesystem object

This keeps `maxConnections` aligned with actual concurrent usage rather than historical usage.

### 4. Teardown reasons now close immediately

Only ordinary operation completion uses idle TTL via `release('released')`.

All teardown-oriented reasons close the underlying pooled connection immediately, including:

- config removal
- service removal
- runtime disposal
- extension deactivation
- pool disposal

This prevents deleted or retired configurations from leaving remote sessions alive until idle timeout expiry.

## Final Architecture

### Connection pool contract

The pool owns connection entries and returns short-lived leases:

- `acquire(spec, observer?)`
- lease-scoped `getFileSystem()`
- `release(reason)`
- `dispose()`

The pool tracks:

- current pooled entries
- lease ref count per entry
- pending connect promise per entry
- idle timer per entry
- waiter queue when the pool is at capacity

### Remote access contract

Remote filesystem usage now follows one sanctioned pattern:

```ts
await fileService.withRemoteFileSystem(config, async remoteFs => {
  // use remoteFs only inside this callback
});
```

There is no supported public API for retrieving a pooled remote filesystem object and using it outside the lease scope.

### Identity model

Connection identity is now based on a normalized `ConnectionSpec`, not on raw object value concatenation.

The spec includes all fields that materially affect transport behavior, including:

- protocol
- host / port / username
- auth-related fields
- hop chain
- FTP security options
- remote time offset
- transport algorithm overrides

It excludes unrelated service-level fields such as watcher, sync, and UI options.

## Deviations from the Original Pitch

The final implementation intentionally diverged from two parts of the original draft:

1. The original draft described `FileService`-held references as the primary lifetime model.
   Final implementation uses operation-scoped leases to avoid long-lived capacity pinning.

2. The original draft implied identity could be represented by a simple endpoint string.
   Final implementation uses a normalized transport spec because endpoint-only identity is too weak for auth mode, hop chain, and FTP security variance.

These changes were necessary to reach the actual industrial-grade target rather than the earlier intermediate design.

## Validation

The implementation is backed by:

- unit coverage for `ConnectionPool`
- lifecycle tests for `FileService`
- regression coverage for connection event behavior
- full repository typecheck and test pass during landing

## Follow-up Notes

This pitch is now historical record, not an open proposal.

Any future work on this area should build on the implemented architecture in:

- `src/core/connectionPool.ts`
- `src/core/fileService.ts`
- `src/modules/serviceManager/index.ts`
- `src/extension.ts`
