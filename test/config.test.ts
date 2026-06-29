import Joi from 'joi';

const nullable = schema => schema.optional().allow(null);

const configSchema = {
  context: Joi.string(),
  protocol: Joi.any().valid('sftp', 'ftp', 'test'),
  host: Joi.string().required(),
  port: Joi.number().integer(),
  username: Joi.string().required(),
  password: nullable(Joi.string()),
  agent: nullable(Joi.string()),
  privateKeyPath: nullable(Joi.string()),
  passphrase: nullable(Joi.string().allow(true)),
  interactiveAuth: Joi.alternatives([
    Joi.boolean(),
    Joi.array().items(Joi.string()),
  ]).optional(),
  secure: Joi.any().valid(true, false, 'control', 'implicit').optional(),
  secureOptions: nullable(Joi.object()),
  passive: Joi.boolean().optional(),
  remotePath: Joi.string().required(),
  uploadOnSave: Joi.boolean().optional(),
  useTempFile: Joi.boolean().optional(),
  openSsh: Joi.boolean().optional(),
  syncMode: Joi.any().valid('update', 'full'),
  ignore: Joi.array().min(0).items(Joi.string()),
  watcher: {
    files: Joi.string().allow(false, null).optional(),
    autoUpload: Joi.boolean().optional(),
    autoDelete: Joi.boolean().optional(),
  },
};

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
    syncMode: 'update',
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
    },
    ignore: [
      '**/.vscode',
      '**/.git',
      '**/.DS_Store',
    ],
  };
}

function validate(config) {
  return Joi.validate(config, configSchema, {
    convert: false,
  });
}

describe('validation config', () => {
  test('default config passes', () => {
    expect(validate(createConfig()).error).toBeNull();
  });

  test('partial watcher config passes', () => {
    const config = createConfig();
    config.password = undefined;
    config.agent = undefined;
    config.privateKeyPath = undefined;
    config.watcher = {};

    expect(validate(config).error).toBeNull();

    delete config.watcher;
    expect(validate(config).error).toBeNull();
  });

  test('protocol must be one of known values', () => {
    const config = createConfig();
    config.protocol = 'unknown';

    expect(validate(config).error).not.toBeNull();
  });

  test('watcher files must be false, null, or string', () => {
    const config = createConfig();

    expect(validate(config).error).toBeNull();

    config.watcher.files = '**/*.js';
    expect(validate(config).error).toBeNull();

    config.watcher.files = null;
    expect(validate(config).error).toBeNull();

    config.watcher.files = true;
    expect(validate(config).error).not.toBeNull();
  });

  test('ignore must be an array of string', () => {
    const config = createConfig();
    config.ignore = [true] as any;
    expect(validate(config).error).not.toBeNull();

    config.ignore = ['**/*.js'];
    expect(validate(config).error).toBeNull();
  });
});
