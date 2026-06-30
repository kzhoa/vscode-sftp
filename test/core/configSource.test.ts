import { vi, beforeEach } from 'vitest';
import type { ConfigSource } from '../../src/core/configSource';

const { remoteSettingGet, replaceHomePath, resolvePath, sshParse } = vi.hoisted(() => ({
  remoteSettingGet: vi.fn(),
  replaceHomePath: vi.fn((value: string) => value),
  resolvePath: vi.fn((workspace: string, target: string) => `${workspace}/${target}`),
  sshParse: vi.fn(() => ({ find: () => undefined })),
}));

vi.mock('../../src/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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

vi.mock('ssh-config', () => ({
  parse: sshParse,
  LineType: { DIRECTIVE: 1 },
}));

import {
  filesIgnoredFromConfig,
  mergeConfigWithExternalRefer,
} from '../../src/core/fileServiceConfig';

function createConfig(overrides = {}) {
  return {
    name: 'service',
    context: '.',
    watcher: { files: false, autoUpload: false, autoDelete: false },
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
    ignore: ['**/.git'],
    ignoreFile: '',
    remoteExplorer: { order: 0 },
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

describe('ConfigSource contract', () => {
  describe('readRequired', () => {
    test('returns content for existing file', () => {
      const source: ConfigSource = {
        readRequired: vi.fn(() => 'node_modules\ndist'),
        readOptional: vi.fn(() => null),
      };
      const config = createConfig({ ignoreFile: '/project/.sftpignore' });

      const result = filesIgnoredFromConfig(config as any, source);

      expect(source.readRequired).toHaveBeenCalledWith('/project/.sftpignore');
      expect(result).toEqual(['**/.git', 'node_modules', 'dist']);
    });

    test('throws when file does not exist', () => {
      const source: ConfigSource = {
        readRequired: vi.fn(() => { throw new Error('File /missing not found.'); }),
        readOptional: vi.fn(() => null),
      };
      const config = createConfig({ ignoreFile: '/missing' });

      expect(() => filesIgnoredFromConfig(config as any, source)).toThrow('File /missing not found.');
    });

    test('is not called when ignoreFile is empty', () => {
      const source: ConfigSource = {
        readRequired: vi.fn(),
        readOptional: vi.fn(() => null),
      };
      const config = createConfig({ ignoreFile: '' });

      const result = filesIgnoredFromConfig(config as any, source);

      expect(source.readRequired).not.toHaveBeenCalled();
      expect(result).toEqual(['**/.git']);
    });
  });

  describe('readOptional', () => {
    test('returns content for ssh config', () => {
      const sshContent = 'Host example\n  HostName real.example.com\n  IdentityFile ~/.ssh/id_ed25519';
      sshParse.mockReturnValue({
        find: vi.fn(() => ({
          config: [
            { type: 1, param: 'HostName', value: 'real.example.com' },
            { type: 1, param: 'IdentityFile', value: '~/.ssh/id_ed25519' },
          ],
        })),
      });

      const source: ConfigSource = {
        readRequired: vi.fn(),
        readOptional: vi.fn(() => sshContent),
      };
      const config = createConfig({ sshConfigPath: '~/.ssh/config' });

      const result = mergeConfigWithExternalRefer(config as any, source);

      expect(source.readOptional).toHaveBeenCalledWith('~/.ssh/config');
      expect(result.host).toEqual('real.example.com');
    });

    test('returns null for missing ssh config without error', () => {
      const source: ConfigSource = {
        readRequired: vi.fn(),
        readOptional: vi.fn(() => null),
      };
      const config = createConfig({ sshConfigPath: '/nonexistent/config' });

      const result = mergeConfigWithExternalRefer(config as any, source);

      expect(source.readOptional).toHaveBeenCalledWith('/nonexistent/config');
      expect(result.host).toEqual('example.com');
    });
  });

  describe('config source isolation', () => {
    test('different sources produce different results for same config', () => {
      const sourceA: ConfigSource = {
        readRequired: vi.fn(() => 'pattern-a'),
        readOptional: vi.fn(() => null),
      };
      const sourceB: ConfigSource = {
        readRequired: vi.fn(() => 'pattern-b'),
        readOptional: vi.fn(() => null),
      };
      const config = createConfig({ ignoreFile: '/project/.ignore' });

      const resultA = filesIgnoredFromConfig(config as any, sourceA);
      const resultB = filesIgnoredFromConfig(config as any, sourceB);

      expect(resultA).toEqual(['**/.git', 'pattern-a']);
      expect(resultB).toEqual(['**/.git', 'pattern-b']);
    });
  });
});
