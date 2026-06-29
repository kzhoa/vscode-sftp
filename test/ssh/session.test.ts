import { beforeEach, vi } from 'vitest';
import {
  __enableShellIntegration,
  __fireExecutionEnd,
  __fireShellIntegration,
  __getMockState,
  __resetMock,
  __setExecutionOutput,
  __setPendingMessageResult,
} from 'vscode';
import { createSshLaunchPlan, renderSshCommand } from '../../src/ssh/launchPlan';
import { openSshTerminalSession } from '../../src/ssh/session';

function createConfig(overrides = {}) {
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
    port: 22,
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
    sshCustomParams: '',
    hop: [],
    secure: false,
    secureOptions: {},
    ...overrides,
  } as any;
}

describe('ssh terminal session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetMock();
    __enableShellIntegration();
  });

  test('keeps terminal open after initial connection succeeds', async () => {
    const plan = createSshLaunchPlan(createConfig());
    const command = renderSshCommand(plan);
    const running = openSshTerminalSession(plan, command);
    const terminal = __getMockState().terminals[0];

    __fireShellIntegration(terminal);
    await Promise.resolve();

    const execution = terminal.__executions[0];
    __setExecutionOutput(execution, ['Last login: today']);

    await vi.advanceTimersByTimeAsync(plan.observability.failureWindowMs + 1);
    __fireExecutionEnd(terminal, execution, 0);

    await expect(running).resolves.toEqual({
      result: 'established',
      exitCode: 0,
    });
    expect(terminal.__disposed).toEqual(false);
    expect(__getMockState().errorMessages).toEqual([]);
  });

  test('auto closes terminal and shows details notification on initial failure', async () => {
    const plan = createSshLaunchPlan(createConfig());
    const command = renderSshCommand(plan);
    __setPendingMessageResult('Details');
    const running = openSshTerminalSession(plan, command);
    const terminal = __getMockState().terminals[0];

    __fireShellIntegration(terminal);
    await Promise.resolve();

    const execution = terminal.__executions[0];
    __setExecutionOutput(execution, ['Permission denied (publickey).']);
    __fireExecutionEnd(terminal, execution, 255);

    await expect(running).resolves.toEqual({
      result: 'failed',
      exitCode: 255,
    });
    expect(terminal.__disposed).toEqual(true);
    expect(__getMockState().errorMessages[0].message).toContain('Open SSH in Terminal failed');
    expect(__getMockState().outputVisible).toEqual(true);
  });
});
