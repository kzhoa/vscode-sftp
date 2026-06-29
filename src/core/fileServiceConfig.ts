import * as fs from 'fs';
import * as path from 'path';
import * as sshConfig from 'ssh-config';
import app from '../app';
import logger from '../logger';
import { getUserSetting } from '../host';
import { replaceHomePath, resolvePath } from '../helper';
import { SETTING_KEY_REMOTE } from '../constants';
import upath from './upath';
import Ignore from './ignore';

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
  syncOption: {
    delete: boolean;
    skipCreate: boolean;
    ignoreExisting: boolean;
    update: boolean;
  };
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
}

const DEFAULT_SSHCONFIG_FILE = '~/.ssh/config';

export function filesIgnoredFromConfig(config: FileServiceConfig): string[] {
  const cache = app.fsCache;
  const ignore =
    config.ignore && config.ignore.length ? config.ignore : [];

  if (!config.ignoreFile) {
    return ignore;
  }

  let ignoreFromFile;
  if (cache.has(config.ignoreFile)) {
    ignoreFromFile = cache.get(config.ignoreFile);
  } else if (fs.existsSync(config.ignoreFile)) {
    ignoreFromFile = fs.readFileSync(config.ignoreFile).toString();
    cache.set(config.ignoreFile, ignoreFromFile);
  } else {
    throw new Error(
      `File ${config.ignoreFile} not found. Check your config of "ignoreFile"`
    );
  }

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
  config: FileServiceConfig
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

  const cache = app.fsCache;
  let sshConfigContent;
  if (cache.has(sshConfigPath)) {
    sshConfigContent = cache.get(sshConfigPath);
  } else {
    try {
      sshConfigContent = fs.readFileSync(sshConfigPath, 'utf8');
    } catch (error) {
      logger.warn(error.message, `load ${sshConfigPath} failed`);
      sshConfigContent = '';
    }
    cache.set(sshConfigPath, sshConfigContent);
  }

  if (!sshConfigContent) {
    return copied;
  }

  const parsedSSHConfig = sshConfig.parse(sshConfigContent);
  const section = parsedSSHConfig.find({
    Host: copied.host,
  });

  if (section === null) {
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
    if (!line.param) {
      return;
    }

    const key = mapping.get(line.param.toLowerCase());
    if (key === undefined) {
      return;
    }

    if (key === 'host') {
      copied[key] = line.value;
    } else {
      setConfigValue(copied, key, line.value);
    }
  });

  return copied;
}

export function getCompleteConfig(
  config: FileServiceConfig,
  workspace: string
): FileServiceConfig {
  const mergedConfig = mergeConfigWithExternalRefer(config);

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
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

export function createIgnoreFn(
  config: FileServiceConfig,
  localContext: string
): ServiceConfig['ignore'] {
  const ignoreConfig = filesIgnoredFromConfig(config);
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
