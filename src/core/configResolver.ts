import type { ValidationError } from 'joi';
import {
  chooseDefaultPort,
  createIgnoreFn,
  getCompleteConfig,
  mergeProfile,
  resolveSyncOption,
} from './fileServiceConfig';
import type { FileServiceConfig, ServiceConfig } from './fileServiceConfig';
import type { ConfigSource } from './configSource';
import type { SyncOptionInput } from './syncOption';

export interface ResolveOptions {
  profile: string | null;
  workspace: string;
  baseDir: string;
  validator?: (config: FileServiceConfig) => ValidationError | undefined;
  configSource?: ConfigSource;
}

export function resolveConfig(
  rawConfig: FileServiceConfig,
  options: ResolveOptions
): ServiceConfig {
  const { profile, workspace, baseDir, validator, configSource } = options;

  if (!configSource) {
    throw new Error('resolveConfig requires a configSource');
  }

  const merged = applyProfile(rawConfig, profile);
  const complete = getCompleteConfig(merged.config, workspace, configSource);
  complete.resolvedSyncOption = resolveSyncOption(
    rawConfig.syncOption,
    merged.profileSyncOption
  );

  if (validator) {
    const error = validator(complete);
    if (error) {
      const profileHint =
        rawConfig.profiles && !profile
          ? ' You might want to set a profile first.'
          : '';
      throw new Error(`Config validation fail: ${error.message}.${profileHint}`);
    }
  }

  return finalizeServiceConfig(complete, baseDir, configSource);
}

function applyProfile(
  rawConfig: FileServiceConfig,
  profile: string | null
): { config: FileServiceConfig; profileSyncOption: SyncOptionInput | undefined } {
  if (!profile) {
    return { config: rawConfig, profileSyncOption: undefined };
  }

  const profiles = rawConfig.profiles;
  if (!profiles || Object.keys(profiles).length === 0) {
    return { config: rawConfig, profileSyncOption: undefined };
  }

  const profileConfig = profiles[profile];
  if (!profileConfig) {
    throw new Error(
      `Unknown profile "${profile}".` +
        ' Please check your profile setting.' +
        ' You can set a profile by running command `SFTP: Set Profile`.'
    );
  }

  return {
    config: mergeProfile(rawConfig, profileConfig),
    profileSyncOption: profileConfig.syncOption,
  };
}

function finalizeServiceConfig(
  config: FileServiceConfig,
  baseDir: string,
  source: ConfigSource
): ServiceConfig {
  const serviceConfig: ServiceConfig = config as any;

  if (serviceConfig.port === undefined) {
    serviceConfig.port = chooseDefaultPort(serviceConfig.protocol);
  }
  if (serviceConfig.protocol === 'ftp') {
    serviceConfig.concurrency = 1;
  }
  serviceConfig.ignore = createIgnoreFn(config, baseDir, source);

  return serviceConfig;
}
