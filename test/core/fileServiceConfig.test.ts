import { beforeEach, vi } from 'vitest';

const {
  appMock,
  loggerMock,
  remoteSettingGet,
  replaceHomePath,
  resolvePath,
  existsSync,
  readFileSync,
  parse,
} = vi.hoisted(() => ({
  appMock: {
    fsCache: new Map<string, string>(),
  },
  loggerMock: {
    warn: vi.fn(),
  },
  remoteSettingGet: vi.fn(),
  replaceHomePath: vi.fn((value: string) => value),
  resolvePath: vi.fn((workspace: string, target: string) => `${workspace}/${target}`),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  parse: vi.fn(),
}));

vi.mock('../../src/app', () => ({
  default: appMock,
}));

vi.mock('../../src/fsCache', () => ({
  default: appMock.fsCache,
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

vi.mock('../../src/host', () => ({
  getUserSetting: () => ({
    get: remoteSettingGet,
  }),
}));

vi.mock('../../src/helper', () => ({
  replaceHomePath,
  resolvePath,
}));

vi.mock('fs', () => ({
  existsSync,
  readFileSync,
}));

vi.mock('ssh-config', () => ({
  parse,
}));

import {
  chooseDefaultPort,
  filesIgnoredFromConfig,
  getCompleteConfig,
  mergeProfile,
  resolveSyncOption,
} from '../../src/core/fileServiceConfig';
import type { ConfigSource } from '../../src/core/configSource';

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
    port: 22,
    username: 'user',
    password: 'secret',
    remotePath: '/remote//dir',
    connectTimeout: 5000,
    protocol: 'ftp',
    uploadOnSave: false,
    useTempFile: false,
    openSsh: false,
    downloadOnOpen: false,
    syncOption: {
      create: true,
      delete: false,
      update: 'source-newer',
      compare: 'mtime-size',
    },
    ignore: ['**/.git'],
    ignoreFile: '',
    remoteExplorer: {
      order: 0,
    },
    remoteTimeOffsetInHours: 0,
    limitOpenFilesOnRemote: true,
    passphrase: '',
    interactiveAuth: false,
    algorithms: {},
    concurrency: 4,
    sshCustomParams: '',
    hop: [] as any,
    secure: false,
    secureOptions: {},
  };
}

beforeEach(() => {
  appMock.fsCache.clear();
  loggerMock.warn.mockReset();
  remoteSettingGet.mockReset();
  replaceHomePath.mockClear();
  resolvePath.mockClear();
  existsSync.mockReset();
  readFileSync.mockReset();
  parse.mockReset();
});

describe('fileServiceConfig helpers', () => {
  test('chooseDefaultPort returns protocol defaults', () => {
    expect(chooseDefaultPort('ftp')).toEqual(21);
    expect(chooseDefaultPort('sftp')).toEqual(22);
  });

  test('mergeProfile concatenates ignore and overrides scalar values', () => {
    const base = createConfig();
    const merged = mergeProfile(base as any, {
      ...createConfig(),
      host: 'prod.example.com',
      ignore: ['dist/**'],
      syncOption: {
        delete: {
          toRemote: true,
        },
      },
    } as any);

    expect(merged.host).toEqual('prod.example.com');
    expect(merged.ignore).toEqual(['**/.git', 'dist/**']);
    expect(merged.syncOption).toEqual({
      delete: {
        toRemote: true,
      },
    });
    expect(merged.profiles).toBeUndefined();
  });

  test('resolveSyncOption merges global and profile directional layers', () => {
    const resolved = resolveSyncOption(
      {
        delete: {
          toRemote: true,
        },
        compare: 'hash',
      },
      {
        update: {
          toLocal: 'never',
        },
      }
    );

    expect(resolved).toEqual({
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
        toRemote: 'source-newer',
      },
      compare: {
        toLocal: 'hash',
        toRemote: 'hash',
      },
      symbolicLink: 'ignore',
    });
  });

  test('filesIgnoredFromConfig reads ignore patterns from ignoreFile', () => {
    const source: ConfigSource = {
      readRequired: vi.fn(() => 'dist\ncoverage'),
      readOptional: vi.fn(() => null),
    };
    const config = {
      ...createConfig(),
      ignoreFile: '/workspace/.sftpignore',
    };

    const ignore = filesIgnoredFromConfig(config as any, source);

    expect(ignore).toEqual(['**/.git', 'dist', 'coverage']);
    expect(source.readRequired).toHaveBeenCalledWith('/workspace/.sftpignore');
  });

  test('getCompleteConfig normalizes paths and resolves env-backed agent', () => {
    process.env.SFTP_AGENT = '/tmp/ssh-agent.sock';
    const source: ConfigSource = {
      readRequired: vi.fn(() => ''),
      readOptional: vi.fn(() => null),
    };
    const config = {
      ...createConfig(),
      agent: '$SFTP_AGENT',
      privateKeyPath: 'keys/id_rsa',
      ignoreFile: '.sftpignore',
    };

    const result = getCompleteConfig(config as any, '/workspace', source);

    expect(result.agent).toEqual('/tmp/ssh-agent.sock');
    expect(result.remotePath).toEqual('/remote/dir');
    expect(result.privateKeyPath).toEqual('/workspace/keys/id_rsa');
    expect(result.ignoreFile).toEqual('/workspace/.sftpignore');
  });
});
