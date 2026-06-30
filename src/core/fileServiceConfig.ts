import * as path from 'path';
import * as sshConfig from 'ssh-config';
import type { Directive, Line, Section } from 'ssh-config';
import logger from '../logger';
import { getUserSetting } from '../host';
import { replaceHomePath, resolvePath } from '../helper';
import { SETTING_KEY_REMOTE } from '../constants';
import upath from './upath';
import Ignore from './ignore';
import type { ConfigSource } from './configSource';
import type { RemoteConnectionSpec, RemoteHopSpec } from './connectionPool';
import {
  DEFAULT_SYNC_OPTION,
  mergeSyncOptions,
  type NormalizedDirectionalSyncOption,
  type SyncOptionInput,
} from './syncOption';

interface Root {
  name: string;
  context: string;
  watcher: WatcherConfig;
  defaultProfile: string;
}

interface Host {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  connectTimeout: number;
}

interface ServiceOption {
  protocol: string;
  remote?: string;
  uploadOnSave: boolean;
  useTempFile: boolean;
  openSsh: boolean;
  downloadOnOpen: boolean | 'confirm';
  filePerm?: number;
  dirPerm?: number;
  syncOption?: SyncOptionInput;
  resolvedSyncOption?: NormalizedDirectionalSyncOption;
  ignore: string[];
  ignoreFile: string;
  remoteExplorer: {
    filesExclude?: string[];
    order: number;
  };
  remoteTimeOffsetInHours: number;
  limitOpenFilesOnRemote: number | true;
}

export interface WatcherConfig {
  files: false | string;
  autoUpload: boolean;
  autoDelete: boolean;
}

interface SftpOption {
  agent?: string;
  privateKeyPath?: string;
  passphrase: string | true;
  interactiveAuth: boolean | string[];
  algorithms: any;
  sshConfigPath?: string;
  concurrency: number;
  sshCustomParams?: string;
  hop: (Host & SftpOption)[] | (Host & SftpOption);
}

interface FtpOption {
  secure: boolean | 'control' | 'implicit';
  secureOptions: any;
  passive?: boolean;
}

export interface FileServiceConfig
  extends Root,
    Host,
    ServiceOption,
    SftpOption,
    FtpOption {
  profiles?: {
    [x: string]: FileServiceConfig;
  };
}

export interface ServiceConfig
  extends Root,
    Host,
    Omit<ServiceOption, 'ignore'>,
    SftpOption,
    FtpOption {
  ignore?: ((fsPath: string) => boolean) | null;
  readonly _generation?: number;
}

const DEFAULT_SSHCONFIG_FILE = '~/.ssh/config';

function isSshSection(line: Line | undefined): line is Section {
  return !!line && 'config' in line;
}

function isSshDirective(line: Line): line is Directive {
  return line.type === sshConfig.LineType.DIRECTIVE;
}

function readSshDirectiveValue(line: Directive): string {
  if (typeof line.value === 'string') {
    return line.value;
  }

  return line.value.map(token => token.val).join('');
}

export function filesIgnoredFromConfig(
  config: FileServiceConfig,
  source: ConfigSource
): string[] {
  const ignore =
    config.ignore && config.ignore.length ? config.ignore : [];

  if (!config.ignoreFile) {
    return ignore;
  }

  const ignoreFromFile = source.readRequired(config.ignoreFile);
  return ignore.concat(ignoreFromFile.split(/\r?\n/g));
}

export function getHostInfo(config) {
  const ignoreOptions = [
    'name',
    'remotePath',
    'uploadOnSave',
    'useTempFile',
    'openSsh',
    'downloadOnOpen',
    'ignore',
    'ignoreFile',
    'watcher',
    'concurrency',
    'syncOption',
    'sshConfigPath',
  ];

  return Object.keys(config).reduce((obj, key) => {
    if (ignoreOptions.indexOf(key) === -1) {
      obj[key] = config[key];
    }
    return obj;
  }, {});
}

function normalizeHopSpec(hop: ServiceConfig['hop']): RemoteConnectionSpec['hop'] {
  if (Array.isArray(hop)) {
    return hop.map(entry => normalizeHopSpec(entry) as RemoteHopSpec);
  }

  if (!hop || typeof hop !== 'object') {
    return undefined;
  }

  const {
    host,
    port,
    username,
    password,
    connectTimeout,
    privateKeyPath,
    passphrase,
    interactiveAuth,
    agent,
    hop: nestedHop,
  } = hop;

  return {
    host,
    port,
    username,
    password,
    connectTimeout,
    privateKeyPath,
    passphrase,
    interactiveAuth,
    agent,
    hop: normalizeHopSpec(nestedHop as ServiceConfig['hop']),
  } as RemoteHopSpec;
}

export function createConnectionSpec(config: ServiceConfig): RemoteConnectionSpec {
  return {
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    connectTimeout: config.connectTimeout,
    privateKeyPath: config.privateKeyPath,
    passphrase: config.passphrase,
    interactiveAuth: config.interactiveAuth,
    agent: config.agent,
    hop: normalizeHopSpec(config.hop),
    limitOpenFilesOnRemote: config.limitOpenFilesOnRemote,
    remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
    secure: config.secure,
    secureOptions: config.secureOptions,
    passive: config.passive,
    algorithms: config.algorithms,
  };
}

export function chooseDefaultPort(protocol: string) {
  return protocol === 'ftp' ? 21 : 22;
}

function setConfigValue(config, key, value) {
  if (config[key] === undefined) {
    if (key === 'port') {
      config[key] = parseInt(value, 10);
    } else {
      config[key] = value;
    }
  }
}

export function mergeConfigWithExternalRefer(
  config: FileServiceConfig,
  source: ConfigSource
): FileServiceConfig {
  const copied = Object.assign({}, config);

  if (config.remote) {
    const remoteMap = getUserSetting(SETTING_KEY_REMOTE);
    const remote = remoteMap.get<Record<string, any>>(config.remote);
    if (!remote) {
      throw new Error(`Can\'t not find remote "${config.remote}"`);
    }

    const remoteKeyMapping = new Map([['scheme', 'protocol']]);
    const remoteKeyIgnored = new Map([['rootPath', 1]]);

    Object.keys(remote).forEach(key => {
      if (remoteKeyIgnored.has(key)) {
        return;
      }

      const targetKey = remoteKeyMapping.has(key)
        ? remoteKeyMapping.get(key)
        : key;
      setConfigValue(copied, targetKey, remote[key]);
    });
  }

  if (config.protocol !== 'sftp') {
    return copied;
  }

  const sshConfigPath = replaceHomePath(
    config.sshConfigPath || DEFAULT_SSHCONFIG_FILE
  );

  const sshConfigContent = source.readOptional(sshConfigPath) ?? '';

  if (!sshConfigContent) {
    return copied;
  }

  const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const section = parsedSSHConfig.find({
    Host: copied.host,
  });

  if (!isSshSection(section)) {
    return copied;
  }

  const mapping = new Map([
    ['hostname', 'host'],
    ['port', 'port'],
    ['user', 'username'],
    ['identityfile', 'privateKeyPath'],
    ['serveraliveinterval', 'keepalive'],
    ['connecttimeout', 'connTimeout'],
  ]);

  section.config.forEach(line => {
    if (!isSshDirective(line) || !line.param) {
      return;
    }

    const key = mapping.get(line.param.toLowerCase());
    if (key === undefined) {
      return;
    }

    const lineValue = readSshDirectiveValue(line);

    if (key === 'host') {
      copied[key] = lineValue;
    } else {
      setConfigValue(copied, key, lineValue);
    }
  });

  return copied;
}

export function getCompleteConfig(
  config: FileServiceConfig,
  workspace: string,
  source: ConfigSource
): FileServiceConfig {
  const mergedConfig = mergeConfigWithExternalRefer(config, source);

  if (mergedConfig.agent && mergedConfig.privateKeyPath) {
    logger.warn(
      'Config Option Conflicted. You are specifing "agent" and "privateKey" at the same time, ' +
        'the later will be ignored.'
    );
  }

  mergedConfig.remotePath = upath.normalize(mergedConfig.remotePath);
  if (mergedConfig.privateKeyPath) {
    mergedConfig.privateKeyPath = resolvePath(
      workspace,
      mergedConfig.privateKeyPath
    );
  }

  if (mergedConfig.ignoreFile) {
    mergedConfig.ignoreFile = resolvePath(workspace, mergedConfig.ignoreFile);
  }

  if (mergedConfig.agent && mergedConfig.agent.startsWith('$')) {
    const envVarName = mergedConfig.agent.slice(1);
    const value = process.env[envVarName];
    if (!value) {
      throw new Error(`Environment variable "${envVarName}" not found`);
    }
    mergedConfig.agent = value;
  }

  return mergedConfig;
}

export function mergeProfile(
  target: FileServiceConfig,
  source: FileServiceConfig
): FileServiceConfig {
  const result = Object.assign({}, target);
  delete result.profiles;

  for (const key of Object.keys(source)) {
    if (key === 'ignore') {
      result.ignore = result.ignore.concat(source.ignore);
    } else if (key === 'syncOption') {
      result.syncOption = source.syncOption;
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

export function resolveSyncOption(
  globalSyncOption?: SyncOptionInput,
  profileSyncOption?: SyncOptionInput
): NormalizedDirectionalSyncOption {
  const withGlobal = mergeSyncOptions(
    {
      create: {
        toLocal: DEFAULT_SYNC_OPTION.create,
        toRemote: DEFAULT_SYNC_OPTION.create,
      },
      delete: {
        toLocal: DEFAULT_SYNC_OPTION.delete,
        toRemote: DEFAULT_SYNC_OPTION.delete,
      },
      update: {
        toLocal: DEFAULT_SYNC_OPTION.update,
        toRemote: DEFAULT_SYNC_OPTION.update,
      },
      compare: {
        toLocal: DEFAULT_SYNC_OPTION.compare,
        toRemote: DEFAULT_SYNC_OPTION.compare,
      },
      symbolicLink: DEFAULT_SYNC_OPTION.symbolicLink,
    },
    globalSyncOption
  );

  return mergeSyncOptions(withGlobal, profileSyncOption);
}

export function createIgnoreFn(
  config: FileServiceConfig,
  localContext: string,
  source: ConfigSource
): ServiceConfig['ignore'] {
  const ignoreConfig = filesIgnoredFromConfig(config, source);
  if (ignoreConfig.length <= 0) {
    return null;
  }

  const remoteContext = config.remotePath;
  const ignore = Ignore.from(ignoreConfig);
  return fsPath => {
    const normalizedPath = path.normalize(fsPath);
    const relativePath =
      normalizedPath.indexOf(localContext) === 0
        ? path.relative(localContext, fsPath)
        : upath.relative(remoteContext, fsPath);

    return relativePath !== '' && ignore.ignores(relativePath);
  };
}
