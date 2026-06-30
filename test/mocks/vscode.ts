type Listener<T> = (event: T) => void;

class Disposable {
  constructor(private readonly fn: () => void) {}

  dispose() {
    this.fn();
  }
}

class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();

  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return new Disposable(() => {
      this.listeners.delete(listener);
    });
  };

  fire(event: T) {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  clear() {
    this.listeners.clear();
  }
}

const Nothing = (() => {
  const fn = () => Nothing;
  return new Proxy(fn, {
    apply: () => Nothing,
    get: (target, key) => {
      if (key in target) {
        return Reflect.get(target, key);
      }
      return Nothing;
    },
  });
})();

export class Uri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
  fsPath: string;

  constructor(
    scheme = 'file',
    authority = '',
    path = '',
    query = '',
    fragment = ''
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path;
  }

  static file(path: string) {
    return new Uri('file', '', path, '', '');
  }

  static parse(value: string) {
    return new Uri('file', '', value, '', '');
  }

  toString() {
    return this.fsPath;
  }

  with(change: Partial<Uri>) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }
}

export class RelativePattern {
  constructor(
    public base: string,
    public pattern: string
  ) {}
}

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

const integrationEmitter = new EventEmitter<any>();
const terminalCloseEmitter = new EventEmitter<any>();
const executionEndEmitter = new EventEmitter<any>();

const state = {
  terminals: [] as any[],
  infoMessages: [] as Array<{ message: string; items: any[] }>,
  errorMessages: [] as Array<{ message: string; items: any[] }>,
  warningMessages: [] as Array<{ message: string; items: any[] }>,
  output: [] as string[],
  outputVisible: false,
  quickPickSelection: undefined as any,
  shellIntegrationFactory: undefined as undefined | ((terminal: any) => any),
  pendingMessageResult: undefined as any,
};

function createExecution(command: string, args: string[] = []) {
  let chunks: string[] = [];
  return {
    commandLine: {
      value: [command, ...args].join(' '),
      isTrusted: true,
      confidence: 2,
    },
    cwd: undefined,
    read: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    __setChunks(nextChunks: string[]) {
      chunks = nextChunks;
    },
  };
}

function createShellIntegration(terminal: any) {
  return {
    cwd: undefined,
    executeCommand(command: string, args: string[] = []) {
      const execution = createExecution(command, args);
      terminal.__executions.push(execution);
      return execution;
    },
  };
}

function createTerminal(name?: string) {
  const terminal = {
    name,
    shellIntegration: undefined as any,
    exitStatus: undefined,
    state: {
      isInteractedWith: false,
      shell: 'bash',
    },
    __shown: false,
    __disposed: false,
    __executions: [] as any[],
    sendText() {},
    show() {
      terminal.__shown = true;
    },
    hide() {},
    dispose() {
      terminal.__disposed = true;
      terminalCloseEmitter.fire(terminal);
    },
  };
  state.terminals.push(terminal);
  if (state.shellIntegrationFactory) {
    terminal.shellIntegration = state.shellIntegrationFactory(terminal);
  }
  return terminal;
}

export const window = {
  showErrorMessage: async (message: string, ...items: any[]) => {
    state.errorMessages.push({ message, items });
    return state.pendingMessageResult;
  },
  showInformationMessage: async (message: string, ...items: any[]) => {
    state.infoMessages.push({ message, items });
    return state.pendingMessageResult;
  },
  showWarningMessage: async (message: string, ...items: any[]) => {
    state.warningMessages.push({ message, items });
    return state.pendingMessageResult;
  },
  showQuickPick: async () => state.quickPickSelection,
  createOutputChannel: () => ({
    appendLine(line: string) {
      state.output.push(line);
    },
    show() {
      state.outputVisible = true;
    },
    hide() {
      state.outputVisible = false;
    },
    dispose() {},
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: undefined,
    show() {},
    hide() {},
    dispose() {},
  }),
  createTerminal,
  onDidChangeTerminalShellIntegration: integrationEmitter.event,
  onDidCloseTerminal: terminalCloseEmitter.event,
  onDidEndTerminalShellExecution: executionEndEmitter.event,
  activeTextEditor: undefined,
};

export const workspace = {
  workspaceFolders: [],
  textDocuments: [],
  getConfiguration: () => ({
    get: () => undefined,
  }),
  asRelativePath: (value: string) => value,
  createFileSystemWatcher: () => ({
    dispose() {},
    onDidChange() {},
    onDidCreate() {},
    onDidDelete() {},
  }),
};

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({
    dispose() {},
  }),
};

export function __resetMock() {
  state.terminals.length = 0;
  state.infoMessages.length = 0;
  state.errorMessages.length = 0;
  state.warningMessages.length = 0;
  state.output.length = 0;
  state.outputVisible = false;
  state.quickPickSelection = undefined;
  state.shellIntegrationFactory = undefined;
  state.pendingMessageResult = undefined;
  integrationEmitter.clear();
  terminalCloseEmitter.clear();
  executionEndEmitter.clear();
}

export function __getMockState() {
  return state;
}

export function __setQuickPickSelection(selection: any) {
  state.quickPickSelection = selection;
}

export function __setPendingMessageResult(result: any) {
  state.pendingMessageResult = result;
}

export function __enableShellIntegration(factory?: (terminal: any) => any) {
  state.shellIntegrationFactory = factory || ((terminal: any) => createShellIntegration(terminal));
}

export function __fireShellIntegration(terminal: any) {
  if (!terminal.shellIntegration) {
    terminal.shellIntegration = createShellIntegration(terminal);
  }
  integrationEmitter.fire({
    terminal,
    shellIntegration: terminal.shellIntegration,
  });
}

export function __setExecutionOutput(execution: any, chunks: string[]) {
  execution.__setChunks(chunks);
}

export function __fireExecutionEnd(terminal: any, execution: any, exitCode?: number) {
  executionEndEmitter.fire({
    terminal,
    shellIntegration: terminal.shellIntegration,
    execution,
    exitCode,
  });
}

export default Nothing;
