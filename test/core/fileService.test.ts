import Joi from 'joi';
import { beforeEach, vi } from 'vitest';

const { appMock, loggerMock } = vi.hoisted(() => ({
  appMock: {
    fsCache: new Map<string, string>(),
  },
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/app', () => ({
  default: appMock,
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

import FileService, { StaleConfigError } from '../../src/core/fileService';
import { ConfigStore } from '../../src/core/configStore';
import type { ConfigSource } from '../../src/core/configSource';
import type { ConnectionPool, ConnectionLease } from '../../src/core/connectionPool';

const testConfigSource: ConfigSource = {
  readRequired(path: string) { return ''; },
  readOptional(path: string) { return null; },
};

function createConfig() {
  return {
    name: 'service',
    context: '.',
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
    },
    defaultProfile: '',
    host: 'example.com',
    port: undefined,
    username: 'user',
    password: 'secret',
    remotePath: '/remote',
    connectTimeout: 5000,
    protocol: 'ftp',
    uploadOnSave: false,
    useTempFile: false,
    openSsh: false,
    downloadOnOpen: false,
    syncOption: {
      delete: {
        toRemote: true,
      },
      update: 'always',
    },
    ignore: [],
    ignoreFile: '',
    remoteExplorer: {
      order: 0,
    },
    remoteTimeOffsetInHours: 0,
    limitOpenFilesOnRemote: true,
    passphrase: '',
    interactiveAuth: false,
    algorithms: {},
    concurrency: 8,
    sshCustomParams: '',
    hop: [] as any,
    secure: false,
    secureOptions: {},
    profiles: {
      prod: {
        host: 'prod.example.com',
        ignore: ['dist/**'],
        syncOption: {
          update: {
            toLocal: 'never',
          },
        },
      },
    },
  };
}

function createLease(fileSystem: any = {}) {
  return {
    getFileSystem: vi.fn().mockResolvedValue(fileSystem),
    release: vi.fn(),
  } as unknown as ConnectionLease;
}

function createConnectionPoolMock(fileSystem: any = {}) {
  const lease = createLease(fileSystem);
  return {
    lease,
    pool: {
      acquire: vi.fn().mockResolvedValue(lease),
      getConnectionId: vi.fn().mockReturnValue('connection-id'),
    } as unknown as ConnectionPool,
  };
}

beforeEach(() => {
  appMock.fsCache.clear();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
});

describe('FileService', () => {
  function createTransferTask(
    key: string,
    run: () => unknown | Promise<unknown>
  ) {
    return {
      transferType: 'local ➞ remote',
      schedulingKey: `RemoteFs:${key}`,
      targetFsPath: key,
      localFsPath: `/workspace${key}`,
      run: vi.fn(run),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;
  }

  function createConfigStore(
    rawConfig = createConfig(),
    activeProfile: string | null = null
  ) {
    const store = new ConfigStore(testConfigSource);
    store.loadInitial(
      '/workspace',
      [{ id: '/workspace', rawConfig: rawConfig as any }],
      { validator: () => undefined }
    );
    if (activeProfile !== null) {
      store.setActiveProfile('/workspace', activeProfile);
    }
    return store;
  }

  function createService(options?: {
    rawConfig?: any;
    activeProfile?: string | null;
    fileSystem?: any;
    shutdownTimeoutMs?: number;
  }) {
    const connection = createConnectionPoolMock(options?.fileSystem);
    const watcherService = {
      create: vi.fn(),
      dispose: vi.fn(),
    };
    const service = new FileService('/workspace', '/workspace', {
      configStore: createConfigStore(options?.rawConfig, options?.activeProfile ?? null),
      watcherService,
      connectionPool: connection.pool,
      shutdownTimeoutMs: options?.shutdownTimeoutMs,
    });
    return {
      service,
      watcherService,
      connection,
    };
  }

  test('getConfig merges selected profile and resolves ftp defaults', () => {
    const { service } = createService({
      rawConfig: createConfig(),
      activeProfile: 'prod',
    });

    const config = service.getConfig();

    expect(config.host).toEqual('prod.example.com');
    expect(config.port).toEqual(21);
    expect(config.concurrency).toEqual(1);
    expect(config.ignore).toEqual(expect.any(Function));
    expect(config.resolvedSyncOption).toEqual({
      create: {
        toLocal: true,
        toRemote: true,
      },
      delete: {
        toLocal: false,
        toRemote: true,
      },
      update: {
        toLocal: 'never',
        toRemote: 'always',
      },
      compare: {
        toLocal: 'mtime-size',
        toRemote: 'mtime-size',
      },
      symbolicLink: 'ignore',
    });
  });

  test('getConfig appends profile hint on validation errors', () => {
    const store = createConfigStore();
    (store as any)._validator = () =>
      Joi.object({
        host: Joi.string().required(),
      }).validate({}).error;
    const { pool } = createConnectionPoolMock();
    const service = new FileService('/workspace', '/workspace', {
      configStore: store,
      watcherService: {
        create() {},
        dispose() {},
      },
      connectionPool: pool,
    });

    expect(() => service.getConfig()).toThrow(
      'Config validation fail: "host" is required. You might want to set a profile first.'
    );
  });

  test('getAllConfig expands all profiles', () => {
    const { service } = createService();

    const configs = service.getAllConfig();

    expect(configs).toHaveLength(1);
    expect(configs[0].host).toEqual('prod.example.com');
  });

  test('withRemoteFileSystem acquires a short-lived pool lease per operation', async () => {
    const remoteFs = {};
    const { service, connection } = createService({ fileSystem: remoteFs });

    const config = service.getConfig();
    const first = await service.withRemoteFileSystem(config, async fs => fs);
    const second = await service.withRemoteFileSystem(config, async fs => fs);

    expect(first).toBe(remoteFs);
    expect(second).toBe(remoteFs);
    expect((connection.pool.acquire as any).mock.calls).toHaveLength(2);
    expect((connection.lease.getFileSystem as any).mock.calls).toHaveLength(2);
    expect(connection.lease.release).toHaveBeenNthCalledWith(1, 'released');
    expect(connection.lease.release).toHaveBeenNthCalledWith(2, 'released');
  });

  test('createTransferScheduler emits transfer lifecycle events', async () => {
    const { service } = createService();
    const scheduler = service.createTransferScheduler(1);
    const before = vi.fn();
    const after = vi.fn();
    const task = {
      run: vi.fn(async () => undefined),
      cancel: vi.fn(),
    } as any;

    service.beforeTransfer(before);
    service.afterTransfer(after);
    scheduler.add(task);
    await scheduler.run();

    expect(before).toHaveBeenCalledWith(task);
    expect(after).toHaveBeenCalledWith(null, task);
    expect(service.getPendingTransferTasks()).toEqual([]);
    expect(service.isTransferring()).toEqual(false);
  });

  test('cancelTransferTasks stops schedulers and cancels pending tasks', async () => {
    let resolveTask;
    const taskPromise = new Promise<void>(resolve => {
      resolveTask = resolve;
    });
    const task = {
      run: vi.fn(() => taskPromise),
      cancel: vi.fn(),
    } as any;
    const { service } = createService();
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(task);
    const running = scheduler.run();
    await Promise.resolve();

    service.cancelTransferTasks();
    resolveTask();
    await running;

    expect(task.cancel).toHaveBeenCalled();
    expect(service.getPendingTransferTasks()).toEqual([]);
  });

  test('cancelTransferTasks resolves run when queued non-upload tasks are dropped', async () => {
    let resolveFirstTask;
    const firstTaskPromise = new Promise<void>(resolve => {
      resolveFirstTask = resolve;
    });
    const firstTask = {
      transferType: 'remote ➞ local',
      schedulingKey: 'download:first',
      targetFsPath: '/workspace/first.txt',
      localFsPath: '/workspace/first.txt',
      run: vi.fn(() => firstTaskPromise),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;
    const secondTask = {
      transferType: 'remote ➞ local',
      schedulingKey: 'download:second',
      targetFsPath: '/workspace/second.txt',
      localFsPath: '/workspace/second.txt',
      run: vi.fn(async () => undefined),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;
    const { service } = createService();
    const scheduler = service.createTransferScheduler(1);

    scheduler.add(firstTask);
    scheduler.add(secondTask);
    const running = scheduler.run();
    await Promise.resolve();

    service.cancelTransferTasks();
    resolveFirstTask();
    await running;

    expect(firstTask.run).toHaveBeenCalledTimes(1);
    expect(secondTask.run).not.toHaveBeenCalled();
    expect(firstTask.cancel).toHaveBeenCalledTimes(1);
    expect(service.isTransferring()).toEqual(false);
  });

  test('deduplicates queued uploads across schedulers and runs latest task once', async () => {
    const { service } = createService();
    const firstScheduler = service.createTransferScheduler(1);
    const secondScheduler = service.createTransferScheduler(1);
    const firstTask = createTransferTask('/remote/file.txt', async () => undefined);
    const secondTask = createTransferTask('/remote/file.txt', async () => undefined);

    firstScheduler.add(firstTask);
    secondScheduler.add(secondTask);

    await Promise.all([firstScheduler.run(), secondScheduler.run()]);

    expect(firstTask.run).not.toHaveBeenCalled();
    expect(secondTask.run).toHaveBeenCalledTimes(1);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      '[dedup] queued task replaced for /remote/file.txt'
    );
  });

  test('reruns latest upload once when same path changes during execution', async () => {
    let resolveFirstTask;
    const firstTaskPromise = new Promise<void>(resolve => {
      resolveFirstTask = resolve;
    });
    const { service } = createService();
    const firstScheduler = service.createTransferScheduler(1);
    const secondScheduler = service.createTransferScheduler(1);
    const firstTask = createTransferTask('/remote/file.txt', () => firstTaskPromise);
    const secondTask = createTransferTask('/remote/file.txt', async () => undefined);

    firstScheduler.add(firstTask);
    const firstRun = firstScheduler.run();
    await Promise.resolve();

    secondScheduler.add(secondTask);
    const secondRun = secondScheduler.run();
    resolveFirstTask();

    await Promise.all([firstRun, secondRun]);

    expect(firstTask.run).toHaveBeenCalledTimes(1);
    expect(secondTask.run).toHaveBeenCalledTimes(1);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      '[dedup] in-flight task marked dirty for /remote/file.txt'
    );
    expect(loggerMock.debug).toHaveBeenCalledWith(
      '[dedup] rerun scheduled after execution for /remote/file.txt'
    );
  });

  test('cancelTransferTasks clears queued deduplicated uploads', async () => {
    const { service } = createService();
    const scheduler = service.createTransferScheduler(1);
    const task = createTransferTask('/remote/file.txt', async () => undefined);

    scheduler.add(task);
    service.cancelTransferTasks();
    await scheduler.run();

    expect(task.run).not.toHaveBeenCalled();
    expect(service.isTransferring()).toEqual(false);
  });

  test('reload waits for running transfers without leaking idle leases across the runtime', async () => {
    let resolveTask;
    const taskPromise = new Promise<void>(resolve => {
      resolveTask = resolve;
    });
    const { service, connection } = createService();
    const scheduler = service.createTransferScheduler(1);
    const task = {
      transferType: 'remote ➞ local',
      schedulingKey: 'download:first',
      targetFsPath: '/workspace/first.txt',
      localFsPath: '/workspace/first.txt',
      run: vi.fn(() => taskPromise),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;

    await service.withRemoteFileSystem(service.getConfig(), async () => undefined);
    scheduler.add(task);
    const running = scheduler.run();
    await Promise.resolve();

    const reloading = service.requestReload('config-changed');
    await Promise.resolve();
    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(connection.lease.release).toHaveBeenCalledWith('released');

    resolveTask();
    await running;
    await reloading;
  });

  test('dispose delegates watcher cleanup without retaining remote leases after use', async () => {
    const { service, watcherService, connection } = createService();

    await service.withRemoteFileSystem(service.getConfig(), async () => undefined);
    await service.requestDispose('service-disposed');

    expect(watcherService.create).toHaveBeenCalledWith('/workspace', createConfig().watcher);
    expect(watcherService.dispose).toHaveBeenCalledWith('/workspace');
    expect(connection.lease.release).toHaveBeenCalledWith('released');
  });

  test('reload timeout keeps old runtime tasks visible and cancellable', async () => {
    let resolveTask;
    const taskPromise = new Promise<void>(resolve => {
      resolveTask = resolve;
    });
    const task = {
      transferType: 'remote ➞ local',
      schedulingKey: 'download:stuck',
      targetFsPath: '/workspace/stuck.txt',
      localFsPath: '/workspace/stuck.txt',
      run: vi.fn(() => taskPromise),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;
    const { service } = createService({ shutdownTimeoutMs: 1 });
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(task);
    const running = scheduler.run();
    await Promise.resolve();

    await service.requestReload('config-changed');

    expect(service.isTransferring()).toEqual(true);
    expect(service.getPendingTransferTasks()).toEqual([task]);

    service.cancelTransferTasks();
    expect(task.cancel).toHaveBeenCalledTimes(2);

    resolveTask();
    await running;
    expect(service.isTransferring()).toEqual(false);
  });

  test('reload keeps draining runtime observable without double-counting before shutdown completes', async () => {
    let resolveTask;
    const taskPromise = new Promise<void>(resolve => {
      resolveTask = resolve;
    });
    const task = {
      transferType: 'remote ➞ local',
      schedulingKey: 'download:draining-visible',
      targetFsPath: '/workspace/draining-visible.txt',
      localFsPath: '/workspace/draining-visible.txt',
      run: vi.fn(() => taskPromise),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;
    const { service } = createService();
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(task);
    const running = scheduler.run();
    await Promise.resolve();

    const reloading = service.requestReload('config-changed');
    await Promise.resolve();

    expect(service.isTransferring()).toEqual(true);
    expect(service.getPendingTransferTasks()).toEqual([task]);

    service.cancelTransferTasks();
    expect(task.cancel).toHaveBeenCalledTimes(2);

    resolveTask();
    await running;
    await reloading;
    expect(service.isTransferring()).toEqual(false);
  });

  test('createTransferScheduler rejects new work while runtime is draining', async () => {
    let resolveTask;
    const taskPromise = new Promise<void>(resolve => {
      resolveTask = resolve;
    });
    const task = {
      transferType: 'remote ➞ local',
      schedulingKey: 'download:draining',
      targetFsPath: '/workspace/draining.txt',
      localFsPath: '/workspace/draining.txt',
      run: vi.fn(() => taskPromise),
      cancel: vi.fn(),
      isCancelled: vi.fn(() => false),
    } as any;
    const { service } = createService();
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(task);
    const running = scheduler.run();
    await Promise.resolve();

    const reloading = service.requestReload('config-changed');
    await Promise.resolve();

    expect(() => service.createTransferScheduler(1)).toThrow(
      'FileService runtime is not accepting new work for /workspace'
    );

    resolveTask();
    await running;
    await reloading;
  });

  test('reload waits for in-flight withRemoteFileSystem action before creating next runtime', async () => {
    let resolveAction;
    const actionPromise = new Promise<void>(resolve => {
      resolveAction = resolve;
    });
    const { service, watcherService } = createService();
    const fsAction = service.withRemoteFileSystem(service.getConfig(), async () => {
      await actionPromise;
    });

    await Promise.resolve();

    let reloadSettled = false;
    const reloading = service.requestReload('config-changed').then(() => {
      reloadSettled = true;
    });

    await Promise.resolve();

    expect(reloadSettled).toEqual(false);
    expect(watcherService.create).toHaveBeenCalledTimes(1);

    resolveAction();
    await fsAction;
    await reloading;

    expect(watcherService.dispose).toHaveBeenCalledTimes(1);
    expect(watcherService.create).toHaveBeenCalledTimes(2);
  });

  test('withRemoteFileSystem rejects new local work while runtime is draining', async () => {
    let resolveAction;
    const actionPromise = new Promise<void>(resolve => {
      resolveAction = resolve;
    });
    const rawConfig = {
      ...createConfig(),
      protocol: 'local',
    };
    const { service } = createService({ rawConfig });
    const config = service.getConfig();
    const runningAction = service.withRemoteFileSystem(config, async () => {
      await actionPromise;
    });

    await Promise.resolve();

    const reloading = service.requestReload('config-changed');
    await Promise.resolve();

    await expect(service.withRemoteFileSystem(config, async () => undefined)).rejects.toThrow(
      'FileService runtime is not accepting new work for /workspace'
    );

    resolveAction();
    await runningAction;
    await reloading;
  });

  it('rejects withRemoteFileSystem when config generation is stale', async () => {
    const rawConfig = { ...createConfig(), protocol: 'local' };
    const { service } = createService({ rawConfig });

    const config = service.getConfig();
    await service.requestReload('test');

    await expect(service.withRemoteFileSystem(config, async () => 'result')).rejects.toBeInstanceOf(
      StaleConfigError
    );
  });

  it('allows withRemoteFileSystem when config has no generation stamp', async () => {
    const rawConfig = { ...createConfig(), protocol: 'local' };
    const { service } = createService({ rawConfig });

    const config = { ...service.getConfig() };
    delete (config as any)._generation;

    const result = await service.withRemoteFileSystem(config, async () => 'ok');
    expect(result).toBe('ok');
  });
});
