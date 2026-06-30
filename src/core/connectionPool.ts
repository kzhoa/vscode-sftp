import { createHash } from 'crypto';
import { promptForPassword } from '../host';
import logger from '../logger';
import upath from './upath';
import { ConnectOption } from './remote-client/remoteClient';
import type {
  RemoteConnectionEvent,
  RemoteConnectionObserver,
  RemoteConnectionState,
} from './remoteConnectionEvent';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';

export interface RemoteHopSpec extends Omit<ConnectOption, 'debug' | 'hop'> {
  hop?: RemoteHopSpec | RemoteHopSpec[];
}

export interface RemoteConnectionSpec extends Omit<ConnectOption, 'debug' | 'hop'> {
  protocol: string;
  remoteTimeOffsetInHours: number;
  algorithms?: any;
  hop?: RemoteHopSpec | RemoteHopSpec[];
}

export interface ConnectionPoolOptions {
  maxConnections?: number;
  idleTimeoutMs?: number;
  acquireTimeoutMs?: number;
}

export interface ConnectionPoolPolicy {
  maxConnections: number;
  idleTimeoutMs: number;
  acquireTimeoutMs: number;
}

type ConnectionEntryState =
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'disconnected'
  | 'disposed';

interface ConnectionEntry {
  id: string;
  spec: RemoteConnectionSpec;
  label: string;
  state: ConnectionEntryState;
  fs: RemoteFileSystem | null;
  pendingPromise: Promise<RemoteFileSystem> | null;
  leaseCount: number;
  idleTimer: NodeJS.Timeout | null;
  lastReleasedAt: number | null;
  observers: Set<RemoteConnectionObserver>;
}

interface ConnectionWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

const DEFAULT_POLICY: ConnectionPoolPolicy = {
  maxConnections: 16,
  idleTimeoutMs: 60_000,
  acquireTimeoutMs: 30_000,
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export function createConnectionId(spec: RemoteConnectionSpec): string {
  return createHash('sha256')
    .update(stableSerialize(spec))
    .digest('hex');
}

export function createConnectionLabel(spec: RemoteConnectionSpec): string {
  const primary = `${spec.protocol}://${spec.username ?? 'anonymous'}@${spec.host}:${spec.port}`;
  const hops = Array.isArray(spec.hop) ? spec.hop : spec.hop ? [spec.hop] : [];
  if (hops.length <= 0) {
    return primary;
  }

  const chain = hops.map(hop => `${hop.username ?? 'anonymous'}@${hop.host}:${hop.port}`).join(' -> ');
  return `${primary} via ${chain}`;
}

function createRemoteFileSystem(spec: RemoteConnectionSpec): RemoteFileSystem {
  const connectOption = { ...spec } as ConnectOption & {
    protocol: string;
    remoteTimeOffsetInHours: number;
    algorithms?: any;
  };
  let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;

  if (spec.protocol === 'sftp') {
    connectOption.debug = function debug(str) {
      const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

      if (log) {
        if (log[1] === 'Parser') return;
        logger.debug(`${log[1]}: ${log[2]}`);
      } else {
        logger.debug(str);
      }
    };
    FsConstructor = SFTPFileSystem;
  } else if (spec.protocol === 'ftp') {
    connectOption.debug = function debug(str) {
      const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

      if (!log) return;
      if (log[2].match(/200 NOOP/)) return;
      if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

      logger.debug(`${log[1]} ${log[2]}`);
    };
    FsConstructor = FTPFileSystem;
  } else {
    throw new Error(`unsupported protocol ${spec.protocol}`);
  }

  return new FsConstructor(upath, {
    clientOption: connectOption as ConnectOption,
    remoteTimeOffsetInHours: spec.remoteTimeOffsetInHours,
  });
}

function toRemoteEvent(state: ConnectionEntryState, reason?: string): RemoteConnectionEvent {
  let mappedState: RemoteConnectionState;
  switch (state) {
    case 'connecting':
    case 'ready':
      mappedState = state;
      break;
    case 'failed':
      mappedState = 'failed';
      break;
    default:
      mappedState = 'disconnected';
      break;
  }

  return reason ? { state: mappedState, reason } : { state: mappedState };
}

class ConnectionLease {
  private _released = false;
  private readonly _disposeObserver: (() => void) | null;

  constructor(
    private readonly _pool: ConnectionPool,
    private readonly _entry: ConnectionEntry,
    observer?: RemoteConnectionObserver
  ) {
    this._disposeObserver = observer ? this.subscribe(observer) : null;
  }

  get id(): string {
    return this._entry.id;
  }

  get spec(): RemoteConnectionSpec {
    return this._entry.spec;
  }

  get released(): boolean {
    return this._released;
  }

  async getFileSystem(): Promise<FileSystem> {
    if (this._released) {
      throw new Error(`Connection lease already released for ${this._entry.label}`);
    }
    return this._pool._connectEntry(this._entry);
  }

  subscribe(observer: RemoteConnectionObserver): () => void {
    if (this._released) {
      throw new Error(`Connection lease already released for ${this._entry.label}`);
    }
    return this._pool._subscribe(this._entry, observer);
  }

  release(reason: string = 'released'): void {
    if (this._released) {
      return;
    }

    this._released = true;
    if (this._disposeObserver) {
      this._disposeObserver();
    }
    this._pool._releaseEntry(this._entry, reason);
  }
}

export class ConnectionPool {
  private _entries: Map<string, ConnectionEntry> = new Map();
  private _waiters: ConnectionWaiter[] = [];
  private _policy: ConnectionPoolPolicy;
  private _disposed = false;

  constructor(options: ConnectionPoolOptions = {}) {
    this._policy = {
      ...DEFAULT_POLICY,
      ...options,
    };
  }

  getPolicy(): ConnectionPoolPolicy {
    return { ...this._policy };
  }

  updatePolicy(options: ConnectionPoolOptions): void {
    this._policy = {
      ...this._policy,
      ...options,
    };
    this._evictIdleEntriesToCapacity();
    this._processWaiters();
  }

  getConnectionId(spec: RemoteConnectionSpec): string {
    return createConnectionId(spec);
  }

  async acquire(
    spec: RemoteConnectionSpec,
    observer?: RemoteConnectionObserver
  ): Promise<ConnectionLease> {
    if (this._disposed) {
      throw new Error('ConnectionPool is disposed');
    }

    while (true) {
      const existing = this._entries.get(createConnectionId(spec));
      if (existing) {
        this._activateEntry(existing);
        return new ConnectionLease(this, existing, observer);
      }

      this._evictIdleEntriesToCapacity();
      if (this._entries.size < this._policy.maxConnections) {
        const entry = this._createEntry(spec);
        this._entries.set(entry.id, entry);
        this._activateEntry(entry);
        return new ConnectionLease(this, entry, observer);
      }

      await this._waitForCapacity(spec);
    }
  }

  async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }

    this._disposed = true;
    this._rejectWaiters(new Error('ConnectionPool is disposed'));
    Array.from(this._entries.values()).forEach(entry => {
      this._closeEntry(entry, 'pool-disposed');
    });
    this._entries.clear();
  }

  _subscribe(entry: ConnectionEntry, observer: RemoteConnectionObserver): () => void {
    entry.observers.add(observer);
    observer.next(toRemoteEvent(entry.state));
    return () => {
      entry.observers.delete(observer);
    };
  }

  async _connectEntry(entry: ConnectionEntry): Promise<RemoteFileSystem> {
    if (this._disposed) {
      throw new Error('ConnectionPool is disposed');
    }

    if (entry.state === 'ready' && entry.fs) {
      return entry.fs;
    }

    if (entry.pendingPromise) {
      return entry.pendingPromise;
    }

    entry.state = 'connecting';
    this._emit(entry, { state: 'connecting' });

    const fs = createRemoteFileSystem(entry.spec);
    entry.fs = fs;
    fs.onDisconnected(reason => {
      this._handleDisconnection(entry.id, reason);
    });

    entry.pendingPromise = fs
      .connect({ ...(entry.spec as unknown as ConnectOption) }, { askForPasswd: promptForPassword })
      .then(
        () => {
          entry.pendingPromise = null;
          entry.fs = fs;
          entry.state = 'ready';
          this._emit(entry, { state: 'ready' });
          return fs;
        },
        error => {
          entry.pendingPromise = null;
          this._handleDisconnection(entry.id, 'error');
          throw error;
        }
      );

    return entry.pendingPromise;
  }

  _releaseEntry(entry: ConnectionEntry, reason: string): void {
    const current = this._entries.get(entry.id);
    if (!current) {
      return;
    }

    current.leaseCount = Math.max(0, current.leaseCount - 1);
    if (current.leaseCount > 0) {
      return;
    }

    current.lastReleasedAt = Date.now();
    if (reason !== 'released') {
      this._closeEntry(current, reason);
      this._processWaiters();
      return;
    }

    this._armIdleTimer(current);
    this._processWaiters();
  }

  private _waitForCapacity(spec: RemoteConnectionSpec): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve: () => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = null;
          }
          resolve();
        },
        reject: error => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = null;
          }
          reject(error);
        },
        timer: null,
      };

      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter(item => item !== waiter);
        reject(
          new Error(
            `Timed out waiting for an available connection slot for ${createConnectionLabel(spec)}`
          )
        );
      }, this._policy.acquireTimeoutMs);

      this._waiters.push(waiter);
    });
  }

  private _createEntry(spec: RemoteConnectionSpec): ConnectionEntry {
    return {
      id: createConnectionId(spec),
      spec: { ...spec },
      label: createConnectionLabel(spec),
      state: 'disconnected',
      fs: null,
      pendingPromise: null,
      leaseCount: 0,
      idleTimer: null,
      lastReleasedAt: null,
      observers: new Set(),
    };
  }

  private _activateEntry(entry: ConnectionEntry): void {
    entry.leaseCount += 1;
    entry.lastReleasedAt = null;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private _armIdleTimer(entry: ConnectionEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    entry.idleTimer = setTimeout(() => {
      const current = this._entries.get(entry.id);
      if (!current || current.leaseCount > 0) {
        return;
      }
      this._closeEntry(current, 'idle-timeout');
      this._processWaiters();
    }, this._policy.idleTimeoutMs);
  }

  private _emit(entry: ConnectionEntry, event: RemoteConnectionEvent): void {
    entry.observers.forEach(observer => {
      observer.next(event);
    });
  }

  private _handleDisconnection(entryId: string, reason: string): void {
    const entry = this._entries.get(entryId);
    if (!entry) {
      return;
    }

    if (entry.pendingPromise) {
      entry.pendingPromise = null;
    }
    if (entry.fs) {
      entry.fs.end();
      entry.fs = null;
    }

    entry.state = reason === 'error' ? 'failed' : 'disconnected';
    this._emit(entry, {
      state: reason === 'error' ? 'failed' : 'disconnected',
      reason,
    });

    if (entry.leaseCount <= 0) {
      this._armIdleTimer(entry);
    }
  }

  private _closeEntry(entry: ConnectionEntry, reason: string): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.pendingPromise) {
      entry.pendingPromise = null;
    }
    if (entry.fs) {
      entry.fs.end();
      entry.fs = null;
    }

    entry.state = 'disposed';
    this._entries.delete(entry.id);
    if (reason !== 'pool-disposed') {
      this._emit(entry, { state: 'disconnected', reason });
    }
    entry.observers.clear();
  }

  private _evictIdleEntriesToCapacity(): void {
    while (this._entries.size >= this._policy.maxConnections) {
      const candidate = this._findOldestIdleEntry();
      if (!candidate) {
        return;
      }
      this._closeEntry(candidate, 'capacity-eviction');
    }
  }

  private _findOldestIdleEntry(): ConnectionEntry | undefined {
    let candidate: ConnectionEntry | undefined;
    this._entries.forEach(entry => {
      if (entry.leaseCount > 0) {
        return;
      }
      if (!candidate) {
        candidate = entry;
        return;
      }
      const candidateTime = candidate.lastReleasedAt ?? 0;
      const entryTime = entry.lastReleasedAt ?? 0;
      if (entryTime < candidateTime) {
        candidate = entry;
      }
    });
    return candidate;
  }

  private _processWaiters(): void {
    while (this._waiters.length > 0 && this._entries.size < this._policy.maxConnections) {
      const waiter = this._waiters.shift();
      waiter?.resolve();
    }
  }

  private _rejectWaiters(error: Error): void {
    const waiters = [...this._waiters];
    this._waiters = [];
    waiters.forEach(waiter => waiter.reject(error));
  }
}

export type { ConnectionLease };
