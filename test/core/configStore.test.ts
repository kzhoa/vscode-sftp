import Joi from 'joi';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../src/app', () => ({
  default: {
    fsCache: new Map<string, string>(),
    sftpBarItem: {
      updateStatus() {},
      showMsg() {},
      reset() {},
    },
  },
}));

import { ConfigStore } from '../../src/core/configStore';

function createConfig(overrides: Record<string, unknown> = {}) {
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
    remotePath: '/remote',
    connectTimeout: 5000,
    protocol: 'sftp',
    uploadOnSave: false,
    useTempFile: false,
    openSsh: false,
    downloadOnOpen: false,
    syncOption: {},
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
    concurrency: 4,
    sshCustomParams: '',
    hop: [] as any,
    secure: false,
    secureOptions: {},
    ...overrides,
  };
}

function validateConfig(config) {
  return Joi.object({
    host: Joi.string().required(),
    username: Joi.string().required(),
    remotePath: Joi.string().required(),
    protocol: Joi.string().valid('sftp', 'ftp', 'local').required(),
  }).validate(config, {
    allowUnknown: true,
    convert: false,
    errors: {
      label: 'key',
    },
  }).error;
}

describe('ConfigStore', () => {
  test('loadInitial keeps invalid profiles visible and selects a valid default profile', () => {
    const store = new ConfigStore();
    const config = createConfig({
      defaultProfile: 'prod',
      profiles: {
        prod: {
          host: 'prod.example.com',
        },
        broken: {
          remotePath: null,
        },
      },
    });

    store.loadInitial(
      '/workspace',
      [{ id: '/workspace', rawConfig: config as any }],
      { validator: validateConfig }
    );

    expect(store.get('/workspace')?.profiles).toEqual(['prod']);
    expect(store.get('/workspace')?.invalidProfiles).toEqual([
      {
        name: 'broken',
        error: expect.stringContaining('must be of type string'),
      },
    ]);
    expect(store.getActiveProfile('/workspace')).toEqual('prod');
  });

  test('reloadWorkspace keeps previous snapshot when base config is invalid', () => {
    const store = new ConfigStore();
    const initialConfig = createConfig({
      defaultProfile: 'prod',
      profiles: {
        prod: {
          host: 'prod.example.com',
        },
      },
    });
    store.loadInitial(
      '/workspace',
      [{ id: '/workspace', rawConfig: initialConfig as any }],
      { validator: validateConfig }
    );
    store.setActiveProfile('/workspace', 'prod');

    const result = store.reloadWorkspace('/workspace', [{
      id: '/workspace',
      rawConfig: createConfig({
        host: undefined,
        profiles: {
          prod: {
            host: 'next.example.com',
          },
        },
      }) as any,
    }]);

    expect(result.ok).toEqual(false);
    expect(store.get('/workspace')?.rawConfig.host).toEqual('example.com');
    expect(store.getActiveProfile('/workspace')).toEqual('prod');
    expect(store.getResolved('/workspace').host).toEqual('prod.example.com');
  });

  test('reloadWorkspace reconciles active profile and emits activeProfileChanged', () => {
    const store = new ConfigStore();
    store.loadInitial(
      '/workspace',
      [{
        id: '/workspace',
        rawConfig: createConfig({
          defaultProfile: 'dev',
          profiles: {
            dev: {
              host: 'dev.example.com',
            },
            prod: {
              host: 'prod.example.com',
            },
          },
        }) as any,
      }],
      { validator: validateConfig }
    );
    store.setActiveProfile('/workspace', 'prod');

    const onActiveProfileChanged = vi.fn();
    store.onActiveProfileChanged(onActiveProfileChanged);

    const result = store.reloadWorkspace('/workspace', [{
      id: '/workspace',
      rawConfig: createConfig({
        defaultProfile: 'dev',
        profiles: {
          dev: {
            host: 'dev.example.com',
          },
        },
      }) as any,
    }]);

    expect(result).toEqual({ ok: true });
    expect(store.getActiveProfile('/workspace')).toEqual('dev');
    expect(onActiveProfileChanged).toHaveBeenCalledWith(['/workspace']);
  });
});
