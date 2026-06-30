import { validateConfig } from '../src/modules/config';

function createConfig() {
  return {
    host: 'host',
    port: 22,
    username: 'username',
    password: null,
    protocol: 'sftp',
    agent: null,
    privateKeyPath: null,
    passive: false,
    interactiveAuth: false,
    remotePath: '/',
    uploadOnSave: false,
    useTempFile: false,
    openSsh: false,
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
    },
    ignore: ['**/.vscode', '**/.git', '**/.DS_Store'],
  };
}

describe('validation config', () => {
  test('default config passes', () => {
    expect(validateConfig(createConfig())).toBeUndefined();
  });

  test('partial watcher config passes', () => {
    const config = createConfig();
    config.password = undefined as any;
    config.agent = undefined as any;
    config.privateKeyPath = undefined as any;
    config.watcher = {} as any;

    expect(validateConfig(config)).toBeUndefined();

    delete config.watcher;
    expect(validateConfig(config)).toBeUndefined();
  });

  test('protocol must be one of known values', () => {
    const config = createConfig();
    config.protocol = 'unknown' as any;

    expect(validateConfig(config)).toBeDefined();
  });

  test('watcher files must be false, null, or string', () => {
    const config = createConfig();

    expect(validateConfig(config)).toBeUndefined();

    config.watcher.files = '**/*.js';
    expect(validateConfig(config)).toBeUndefined();

    config.watcher.files = null as any;
    expect(validateConfig(config)).toBeUndefined();

    config.watcher.files = true as any;
    expect(validateConfig(config)).toBeDefined();
  });

  test('syncOption accepts new scalar and directional syntax', () => {
    const config = createConfig();
    config.syncOption = {
      create: {
        toRemote: true,
      },
      delete: false,
      update: {
        toLocal: true,
        toRemote: 'never',
      },
      compare: 'hash',
    };

    expect(validateConfig(config)).toBeUndefined();
  });

  test('syncOption rejects legacy fields', () => {
    const config = createConfig();
    config.syncOption = {
      skipCreate: true,
      ignoreExisting: true,
    } as any;

    expect(validateConfig(config)).toBeDefined();
  });
});
