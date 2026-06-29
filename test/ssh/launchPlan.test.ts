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
  test('tokenizeSshCustomParams handles quoted values', () => {
    expect(tokenizeSshCustomParams('-o "StrictHostKeyChecking no" \'abc def\'')).toEqual([
      '-o',
      'StrictHostKeyChecking no',
      'abc def',
    ]);
  });

  test('createSshLaunchPlan normalizes config and preserves custom tokens', () => {
    const plan = createSshLaunchPlan(createConfig());

    expect(plan.destination).toEqual({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
    });
    expect(plan.transport.hops).toHaveLength(1);
    expect(plan.options.flatMap(option => option.args)).toContain('/srv/app');
  });

  test('renderSshCommand filters conflicting user overrides and renders jump chain', () => {
    const plan = createSshLaunchPlan({
      ...createConfig(),
      sshCustomParams: '-p 9999 -o StrictHostKeyChecking=no',
    });

    const rendered = renderSshCommand(plan);

    expect(plan.issues.map(issue => issue.code)).toContain('custom-option-overrides-port');
    expect(rendered.args).toContain('-J');
    expect(rendered.args).toContain('jumper@jump.example.com:22');
    expect(rendered.args).toContain('deploy@example.com');
    expect(rendered.args).not.toContain('9999');
  });
});
