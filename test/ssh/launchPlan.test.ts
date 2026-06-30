import { vi } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    error: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

import { createSshLaunchPlan, renderSshCommand, tokenizeSshCustomParams } from '../../src/ssh/launchPlan';

function createConfig() {
  return {
    name: 'Prod',
    context: '.',
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
    },
    defaultProfile: '',
    host: 'example.com',
    port: 2222,
    username: 'deploy',
    password: '',
    remotePath: '/srv/app',
    connectTimeout: 5000,
    protocol: 'sftp',
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
    ignore: [],
    ignoreFile: '',
    remoteExplorer: {
      order: 0,
    },
    remoteTimeOffsetInHours: 0,
    limitOpenFilesOnRemote: true,
    agent: '',
    privateKeyPath: '/keys/id_ed25519',
    passphrase: '',
    interactiveAuth: false,
    algorithms: {},
    sshConfigPath: '/users/me/.ssh/config',
    concurrency: 4,
    sshCustomParams: '-o StrictHostKeyChecking=no -L 8080:127.0.0.1:80 ${remotePath}',
    hop: [
      {
        host: 'jump.example.com',
        port: 22,
        username: 'jumper',
      },
    ],
    secure: false,
    secureOptions: {},
  } as any;
}

describe('ssh launch plan', () => {
  beforeEach(() => {
    loggerMock.error.mockReset();
  });

  test('tokenizeSshCustomParams handles quoted values', () => {
    expect(tokenizeSshCustomParams('-o "StrictHostKeyChecking no" \'abc def\'')).toEqual([
      '-o',
      'StrictHostKeyChecking no',
      'abc def',
    ]);
  });

  test('createSshLaunchPlan extracts standard fields and preserves pre/post host args', () => {
    const plan = createSshLaunchPlan({
      ...createConfig(),
      port: undefined,
      sshConfigPath: undefined,
      hop: [],
      sshCustomParams:
        '-p 2022 -F /users/me/.ssh/alt-config -L 8080:127.0.0.1:80 bash -lc "cd ${remotePath}; exec $SHELL -l"',
    });

    expect(plan.destination).toEqual({
      host: 'example.com',
      port: 2022,
      username: 'deploy',
    });
    expect(plan.transport.sshConfigPath).toEqual('/users/me/.ssh/alt-config');
    expect(plan.preHostArgs).toEqual(['-L', '8080:127.0.0.1:80']);
    expect(plan.postHostArgs).toEqual(['bash', '-lc', 'cd /srv/app; exec $SHELL -l']);
  });

  test('createSshLaunchPlan rejects conflicting standard fields from sshCustomParams', () => {
    expect(() =>
      createSshLaunchPlan({
        ...createConfig(),
        sshCustomParams: '-p 9999 -o StrictHostKeyChecking=no',
      })
    ).toThrow(/"port" is defined in sftp\.json/);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('"port" is defined in sftp.json')
    );
  });

  test('renderSshCommand renders jump chain and appends post-host args after destination', () => {
    const plan = createSshLaunchPlan({
      ...createConfig(),
      sshCustomParams: '-o StrictHostKeyChecking=no /srv/app',
    });

    const rendered = renderSshCommand(plan);

    expect(rendered.args).toContain('-J');
    expect(rendered.args).toContain('jumper@jump.example.com:22');
    expect(rendered.args).toContain('deploy@example.com');
    expect(rendered.args.indexOf('deploy@example.com')).toBeLessThan(
      rendered.args.indexOf('/srv/app')
    );
  });
});
