import { vi, beforeEach } from 'vitest';

const { promptForPassword, loggerMock } = vi.hoisted(() => ({
  promptForPassword: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/host', () => ({
  promptForPassword,
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

import { createRemoteIfNoneExist, removeRemoteFs } from '../../src/core/remoteFs';
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
    const observer = createObserver();

    await createRemoteIfNoneExist(
      { protocol: 'sftp', host: 'a', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );

    expect(observer.events).toEqual([
      { state: 'connecting' },
      { state: 'ready' },
    ]);
  });

  test('emits connecting then failed on connection error', async () => {
    mockConnect = vi.fn().mockRejectedValue(new Error('timeout'));
    const observer = createObserver();

    await expect(
      createRemoteIfNoneExist(
        { protocol: 'sftp', host: 'b', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
        observer
      )
    ).rejects.toThrow('timeout');

    expect(observer.events).toEqual([
      { state: 'connecting' },
      { state: 'failed', reason: 'error' },
    ]);
  });

  test('emits disconnected when remote drops connection after ready', async () => {
    let disconnectCb: (reason: string) => void;
    mockOnDisconnected = vi.fn((cb) => { disconnectCb = cb; });
    const observer = createObserver();

    await createRemoteIfNoneExist(
      { protocol: 'sftp', host: 'c', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );

    disconnectCb!('end');

    expect(observer.events).toEqual([
      { state: 'connecting' },
      { state: 'ready' },
      { state: 'disconnected', reason: 'end' },
    ]);
  });

  test('reuses pooled connection without re-emitting connecting', async () => {
    const observer = createObserver();

    await createRemoteIfNoneExist(
      { protocol: 'sftp', host: 'd', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer
    );

    const observer2 = createObserver();
    await createRemoteIfNoneExist(
      { protocol: 'sftp', host: 'd', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
      observer2
    );

    expect(observer2.events).toEqual([]);
  });

  test('works without observer (no error thrown)', async () => {
    await expect(
      createRemoteIfNoneExist(
        { protocol: 'sftp', host: 'e', port: 22, username: 'u', remoteTimeOffsetInHours: 0 },
        undefined
      )
    ).resolves.toBeDefined();
  });
});
