import logger from '../logger';
import { interpolate } from '../utils';

const OPTION_TAKES_VALUE = new Set([
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w',
]);

export interface SshLaunchIssue {
  code: string;
  message: string;
}

export interface SshLaunchConfig {
  name?: string;
  protocol?: string;
  remotePath: string;
  host: string;
  port?: number;
  username?: string;
  password?: string;
  agent?: string;
  privateKeyPath?: string;
  interactiveAuth?: boolean | string[];
  sshConfigPath?: string;
  sshCustomParams?: string;
  hop?: SshLaunchConfig[] | SshLaunchConfig;
}

export interface SshOptionPlan {
  kind: 'derived' | 'custom';
  source: 'config' | 'customParams';
  key?: string;
  args: string[];
}

export interface SshHopPlan {
  host: string;
  port: number;
  username: string;
  authMode: 'agent' | 'privateKey' | 'password' | 'interactive' | 'auto';
  privateKeyPath?: string;
  agent?: string;
  sshCustomParams?: string;
}

export interface SshLaunchPlan {
  sessionId: string;
  profileName: string;
  terminalName: string;
  destination: {
    host: string;
    port: number;
    username: string;
  };
  auth: {
    mode: 'agent' | 'privateKey' | 'password' | 'interactive' | 'auto';
    privateKeyPath?: string;
    agent?: string;
  };
  transport: {
    requestTty: boolean;
    sshConfigPath?: string;
    hops: SshHopPlan[];
  };
  options: SshOptionPlan[];
  preHostArgs: string[];
  postHostArgs: string[];
  observability: {
    commandId: string;
    failureWindowMs: number;
  };
  issues: SshLaunchIssue[];
}

export interface RenderedSshCommand {
  command: string;
  args: string[];
  logText: string;
}

function createSessionId() {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function detectAuthMode(config: Partial<SshLaunchConfig>) {
  if (typeof config.agent === 'string' && config.agent.length > 0) {
    return 'agent' as const;
  }

  if (typeof config.privateKeyPath === 'string' && config.privateKeyPath.length > 0) {
    return 'privateKey' as const;
  }

  if (typeof config.password === 'string' && config.password.length > 0) {
    return 'password' as const;
  }

  if (config.interactiveAuth) {
    return 'interactive' as const;
  }

  return 'auto' as const;
}

export function tokenizeSshCustomParams(input?: string): string[] {
  if (!input) {
    return [];
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== '\'') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }

  if (quote) {
    throw new Error(`Invalid sshCustomParams: unclosed ${quote} quote.`);
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

interface ParsedCustomParams {
  extractedConfig: Partial<SshLaunchConfig>;
  preHostArgs: string[];
  postHostArgs: string[];
}

interface ExtractableOption {
  configKey: keyof Pick<SshLaunchConfig, 'port' | 'username' | 'privateKeyPath' | 'sshConfigPath' | 'hop'>;
  readValue: (value: string) => Partial<SshLaunchConfig>;
}

function parsePortValue(value: string, profileName: string, sourceArg: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) {
    const message =
      `Invalid SSH configuration for profile "${profileName}": ` +
      `"${sourceArg}" must be followed by a positive integer port, but received "${value}".`;
    logger.error(message);
    throw new Error(message);
  }

  return port;
}

const EXTRACTABLE_OPTIONS = new Map<string, ExtractableOption>([
  ['-p', {
    configKey: 'port',
    readValue: value => ({ port: Number(value) }),
  }],
  ['-l', {
    configKey: 'username',
    readValue: value => ({ username: value }),
  }],
  ['-i', {
    configKey: 'privateKeyPath',
    readValue: value => ({ privateKeyPath: value }),
  }],
  ['-F', {
    configKey: 'sshConfigPath',
    readValue: value => ({ sshConfigPath: value }),
  }],
  ['-J', {
    configKey: 'hop',
    readValue: value => ({
      hop: value.split(',').filter(Boolean).map(entry => {
        const [userAndHost, portText] = entry.split(':');
        const atIndex = userAndHost.lastIndexOf('@');
        const port = portText ? Number(portText) : 22;
        if (atIndex === -1) {
          return {
            remotePath: '',
            host: userAndHost,
            port,
          };
        }
        return {
          remotePath: '',
          username: userAndHost.slice(0, atIndex),
          host: userAndHost.slice(atIndex + 1),
          port,
        };
      }),
    }),
  }],
]);

function isConfigValueDefined(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  if (Array.isArray(value) && value.length === 0) {
    return false;
  }

  return true;
}

function formatConfigValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function parseCustomParams(
  config: SshLaunchConfig,
  profileName: string
): ParsedCustomParams {
  const tokens = tokenizeSshCustomParams(config.sshCustomParams
    ? interpolate(config.sshCustomParams, { remotePath: config.remotePath || '' })
    : undefined);
  const extractedConfig: Partial<SshLaunchConfig> = {};
  const preHostArgs: string[] = [];
  const postHostArgs: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      postHostArgs.push(...tokens.slice(index));
      break;
    }

    const takesValue = OPTION_TAKES_VALUE.has(token);
    const args = takesValue && tokens[index + 1] !== undefined
      ? [token, tokens[index + 1]]
      : [token];

    if (takesValue && args.length < 2) {
      const message =
        `Invalid SSH configuration for profile "${profileName}": ` +
        `sshCustomParams option "${token}" requires a value.`;
      logger.error(message);
      throw new Error(message);
    }

    index += takesValue ? 1 : 0;

    const extractable = EXTRACTABLE_OPTIONS.get(token);
    if (!extractable) {
      preHostArgs.push(...args);
      continue;
    }

    if (isConfigValueDefined(extractedConfig[extractable.configKey])) {
      const message =
        `Invalid SSH configuration for profile "${profileName}": ` +
        `sshCustomParams declares "${String(extractable.configKey)}" more than once ` +
        `("${args.join(' ')}"). Keep only one value for that SSH option.`;
      logger.error(message);
      throw new Error(message);
    }

    const currentValue = config[extractable.configKey];
    if (isConfigValueDefined(currentValue)) {
      const message =
        `Invalid SSH configuration for profile "${profileName}": ` +
        `"${String(extractable.configKey)}" is defined in sftp.json ` +
        `(${formatConfigValue(currentValue)}) and also in sshCustomParams ` +
        `("${args.join(' ')}"). Remove one of them so there is only one source of truth.`;
      logger.error(message);
      throw new Error(message);
    }

    if (token === '-p') {
      Object.assign(extractedConfig, { port: parsePortValue(args[1], profileName, '-p') });
      continue;
    }

    if (token === '-J') {
      Object.assign(extractedConfig, {
        hop: args[1].split(',').filter(Boolean).map(entry => {
          const [userAndHost, portText] = entry.split(':');
          const port = portText ? parsePortValue(portText, profileName, '-J') : 22;
          const atIndex = userAndHost.lastIndexOf('@');
          if (atIndex === -1) {
            return {
              remotePath: '',
              host: userAndHost,
              port,
            };
          }

          return {
            remotePath: '',
            username: userAndHost.slice(0, atIndex),
            host: userAndHost.slice(atIndex + 1),
            port,
          };
        }),
      });
      continue;
    }

    Object.assign(extractedConfig, extractable.readValue(args[1]));
  }

  return {
    extractedConfig,
    preHostArgs,
    postHostArgs,
  };
}

function normalizeHop(hop: Partial<SshLaunchConfig>): SshHopPlan {
  return {
    host: hop.host || 'localhost',
    port: hop.port || 22,
    username: hop.username || '',
    authMode: detectAuthMode(hop),
    privateKeyPath: hop.privateKeyPath || undefined,
    agent: hop.agent || undefined,
    sshCustomParams: hop.sshCustomParams || undefined,
  };
}

export function createSshLaunchPlan(config: SshLaunchConfig): SshLaunchPlan {
  const sessionId = createSessionId();
  const profileName = config.name || config.remotePath;
  const issues: SshLaunchIssue[] = [];
  const options: SshOptionPlan[] = [];
  const parsedCustomParams = parseCustomParams(config, profileName);
  const resolvedConfig: SshLaunchConfig = {
    ...config,
    ...parsedCustomParams.extractedConfig,
  };

  const hops = Array.isArray(resolvedConfig.hop)
    ? resolvedConfig.hop.map(normalizeHop)
    : resolvedConfig.hop ? [normalizeHop(resolvedConfig.hop)] : [];

  options.push({
    kind: 'derived',
    source: 'config',
    key: '-p',
    args: ['-p', String(resolvedConfig.port ?? 22)],
  });

  if (resolvedConfig.privateKeyPath) {
    options.push({
      kind: 'derived',
      source: 'config',
      key: '-i',
      args: ['-i', resolvedConfig.privateKeyPath],
    });
  }

  if (resolvedConfig.sshConfigPath) {
    options.push({
      kind: 'derived',
      source: 'config',
      key: '-F',
      args: ['-F', resolvedConfig.sshConfigPath],
    });
  }

  if (resolvedConfig.agent && resolvedConfig.agent !== 'pageant') {
    options.push({
      kind: 'derived',
      source: 'config',
      key: '-o',
      args: ['-o', `IdentityAgent=${resolvedConfig.agent}`],
    });
  } else if (resolvedConfig.agent === 'pageant') {
    issues.push({
      code: 'pageant-not-rendered',
      message: 'The "pageant" agent setting is not translated into SSH CLI arguments.',
    });
  }

  for (const hop of hops) {
    if (hop.privateKeyPath || hop.agent || hop.sshCustomParams) {
      issues.push({
        code: 'hop-advanced-auth-not-rendered',
        message: `Hop ${hop.username}@${hop.host}:${hop.port} has hop-specific auth or custom params that cannot be rendered safely in Open SSH in Terminal.`,
      });
    }
  }

  return {
    sessionId,
    profileName,
    terminalName: `SFTP SSH: ${profileName}`,
    destination: {
      host: config.host,
      port: resolvedConfig.port ?? 22,
      username: resolvedConfig.username || '',
    },
    auth: {
      mode: detectAuthMode(resolvedConfig),
      privateKeyPath: resolvedConfig.privateKeyPath || undefined,
      agent: resolvedConfig.agent || undefined,
    },
    transport: {
      requestTty: true,
      sshConfigPath: resolvedConfig.sshConfigPath || undefined,
      hops,
    },
    options,
    preHostArgs: parsedCustomParams.preHostArgs,
    postHostArgs: parsedCustomParams.postHostArgs,
    observability: {
      commandId: sessionId,
      failureWindowMs: 5000,
    },
    issues,
  };
}

function redactArg(arg: string) {
  if (/^IdentityAgent=/.test(arg)) {
    return 'IdentityAgent=******';
  }
  return arg;
}

export function renderSshCommand(plan: SshLaunchPlan): RenderedSshCommand {
  const args: string[] = [];
  if (plan.transport.requestTty) {
    args.push('-t');
  }

  for (const option of plan.options) {
    args.push(...option.args);
  }

  if (plan.transport.hops.length > 0) {
    const jumpChain = plan.transport.hops
      .map(hop => `${hop.username}@${hop.host}:${hop.port}`)
      .join(',');
    args.push('-J', jumpChain);
  }

  args.push(...plan.preHostArgs);
  args.push(`${plan.destination.username}@${plan.destination.host}`);
  args.push(...plan.postHostArgs);

  return {
    command: 'ssh',
    args,
    logText: ['ssh', ...args.map(redactArg)].join(' '),
  };
}
