import Joi from 'joi';
import { beforeEach, vi } from 'vitest';

const { appMock, loggerMock, createRemoteIfNoneExist, removeRemoteFs } = vi.hoisted(() => ({
  appMock: {
    state: {
      profile: null as string | null,
    },
  },
  loggerMock: {
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
      delete: false,
      skipCreate: false,
      ignoreExisting: false,
      update: true,
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
      },
    },
  };
}

beforeEach(() => {
  appMock.state.profile = null;
  loggerMock.info.mockReset();
  createRemoteIfNoneExist.mockReset();
  removeRemoteFs.mockReset();
});

describe('FileService', () => {
  test('getConfig merges selected profile and resolves ftp defaults', () => {
    appMock.state.profile = 'prod';
    const service = new FileService('/workspace', '/workspace', createConfig() as any);

    const config = service.getConfig();

    expect(config.host).toEqual('prod.example.com');
    expect(config.port).toEqual(21);
    expect(config.concurrency).toEqual(1);
    expect(config.ignore).toEqual(expect.any(Function));
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
