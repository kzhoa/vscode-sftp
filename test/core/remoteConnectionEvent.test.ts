import { vi, beforeEach, afterEach } from 'vitest';

const { promptForPassword, loggerMock } = vi.hoisted(() => ({
  promptForPassword: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.useFakeTimers();

vi.mock('../../src/host', () => ({
  promptForPassword,
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

import { ConnectionPool } from '../../src/core/connectionPool';
import type { RemoteConnectionObserver, RemoteConnectionEvent } from '../../src/core/remoteConnectionEvent';

let mockConnect: (option: any, hooks: any) => Promise<void>;
let mockEnd: ReturnType<typeof vi.fn>;
let mockOnDisconnected: ReturnType<typeof vi.fn>;

vi.mock('../../src/core/fs', () => {
  class MockSFTPFileSystem {
    constructor() {}
    connect(option: any, hooks: any) {
      return mockConnect(option, hooks);
    }
    end() {
      mockEnd();
    }
    onDisconnected(cb: (reason: string) => void) {
      mockOnDisconnected(cb);
    }
  }
  return {
    FileSystem: class {},
    RemoteFileSystem: class {},
    SFTPFileSystem: MockSFTPFileSystem,
    FTPFileSystem: class {},
  };
});

beforeEach(() => {
  mockConnect = vi.fn().mockResolvedValue(undefined);
  mockEnd = vi.fn();
  mockOnDisconnected = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
});

function createObserver(): RemoteConnectionObserver & { events: RemoteConnectionEvent[] } {
  const events: RemoteConnectionEvent[] = [];
  return {
    events,
    next(event: RemoteConnectionEvent) {
      events.push(event);
    },
  };
}

describe('RemoteConnectionEvent emission', () => {
  test('emits connecting then ready on successful connection', async () => {
    const pool = new ConnectionPool();
    const observer = createObserver();

    const lease = await pool.acquire(
      { protocol: 'sftp', host: 'a', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );
    await lease.getFileSystem();

    expect(observer.events).toEqual([
      { state: 'disconnected' },
      { state: 'connecting' },
      { state: 'ready' },
    ]);
  });

  test('emits connecting then failed on connection error', async () => {
    mockConnect = vi.fn().mockRejectedValue(new Error('timeout'));
    const pool = new ConnectionPool();
    const observer = createObserver();

    const lease = await pool.acquire(
      { protocol: 'sftp', host: 'b', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );

    await expect(lease.getFileSystem()).rejects.toThrow('timeout');

    expect(observer.events).toEqual([
      { state: 'disconnected' },
      { state: 'connecting' },
      { state: 'failed', reason: 'error' },
    ]);
  });

  test('emits disconnected when remote drops connection after ready', async () => {
    let disconnectCb: (reason: string) => void;
    mockOnDisconnected = vi.fn(cb => {
      disconnectCb = cb;
    });
    const pool = new ConnectionPool();
    const observer = createObserver();

    const lease = await pool.acquire(
      { protocol: 'sftp', host: 'c', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );
    await lease.getFileSystem();

    disconnectCb!('end');

    expect(observer.events).toEqual([
      { state: 'disconnected' },
      { state: 'connecting' },
      { state: 'ready' },
      { state: 'disconnected', reason: 'end' },
    ]);
  });

  test('reuses pooled connection without reconnecting', async () => {
    const pool = new ConnectionPool();
    const observer = createObserver();

    const lease = await pool.acquire(
      { protocol: 'sftp', host: 'd', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );
    await lease.getFileSystem();

    const observer2 = createObserver();
    const lease2 = await pool.acquire(
      { protocol: 'sftp', host: 'd', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer2
    );
    await lease2.getFileSystem();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(observer2.events).toEqual([
      { state: 'ready' },
    ]);
  });

  test('expires idle connections after ttl', async () => {
    const pool = new ConnectionPool({ idleTimeoutMs: 100 });
    const lease = await pool.acquire(
      { protocol: 'sftp', host: 'e', port: 22, username: 'u', remoteTimeOffsetInHours: 0 }
    );
    await lease.getFileSystem();
    lease.release();

    vi.advanceTimersByTime(100);

    expect(mockEnd).toHaveBeenCalled();
  });

  test('closes immediately when released for teardown reasons', async () => {
    const pool = new ConnectionPool({ idleTimeoutMs: 1000 });
    const lease = await pool.acquire(
      { protocol: 'sftp', host: 'f', port: 22, username: 'u', remoteTimeOffsetInHours: 0 }
    );
    await lease.getFileSystem();

    lease.release('config-removed');

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});
