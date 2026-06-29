import Joi from 'joi';
import { beforeEach, vi } from 'vitest';

const { appMock, loggerMock, createRemoteIfNoneExist, removeRemoteFs } = vi.hoisted(() => ({
  appMock: {
    state: {
      profile: null as string | null,
    },
  },
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
  },
  createRemoteIfNoneExist: vi.fn(),
  removeRemoteFs: vi.fn(),
}));

vi.mock('../../src/app', () => ({
  default: appMock,
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

vi.mock('../../src/core/remoteFs', () => ({
  createRemoteIfNoneExist,
  removeRemoteFs,
}));

import FileService from '../../src/core/fileService';

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

beforeEach(() => {
  appMock.state.profile = null;
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  createRemoteIfNoneExist.mockReset();
  removeRemoteFs.mockReset();
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

  test('getConfig merges selected profile and resolves ftp defaults', () => {
    appMock.state.profile = 'prod';
    const service = new FileService('/workspace', '/workspace', createConfig() as any);

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
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
    service.setConfigValidator(() =>
      Joi.object({
        host: Joi.string().required(),
      }).validate({}).error
    );

    expect(() => service.getConfig()).toThrow(
      'Config validation fail: "host" is required. You might want to set a profile first.'
    );
  });

  test('getAllConfig expands all profiles', () => {
    const service = new FileService('/workspace', '/workspace', createConfig() as any);

    const configs = service.getAllConfig();

    expect(configs).toHaveLength(1);
    expect(configs[0].host).toEqual('prod.example.com');
  });

  test('createTransferScheduler emits transfer lifecycle events', async () => {
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
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
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
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
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
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
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
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
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
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
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
    const scheduler = service.createTransferScheduler(1);
    const task = createTransferTask('/remote/file.txt', async () => undefined);

    scheduler.add(task);
    service.cancelTransferTasks();
    await scheduler.run();

    expect(task.run).not.toHaveBeenCalled();
    expect(service.isTransferring()).toEqual(false);
  });

  test('setWatcherService and dispose delegate create/dispose', () => {
    const service = new FileService('/workspace', '/workspace', createConfig() as any);
    const watcherService = {
      create: vi.fn(),
      dispose: vi.fn(),
    };

    service.setWatcherService(watcherService);
    service.dispose();

    expect(watcherService.create).toHaveBeenCalledWith('/workspace', createConfig().watcher);
    expect(watcherService.dispose).toHaveBeenCalledWith('/workspace');
    expect(removeRemoteFs).toHaveBeenCalled();
  });
});
