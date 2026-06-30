type Listener<T> = (event: T) => void;

export class Disposable {
  constructor(private readonly fn: () => void) {}

  dispose() {
    this.fn();
  }
}

export class EventEmitter<T> {
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

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

export class DataTransferItem {
  constructor(readonly value: any) {}

  async asString() {
    return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
  }

  asFile() {
    return undefined;
  }
}

export class DataTransfer implements Iterable<[string, DataTransferItem]> {
  private readonly items = new Map<string, DataTransferItem>();

  get(mimeType: string) {
    return this.items.get(mimeType.toLowerCase());
  }

  set(mimeType: string, value: DataTransferItem) {
    this.items.set(mimeType.toLowerCase(), value);
  }

  forEach(callbackfn: (item: DataTransferItem, mimeType: string, dataTransfer: DataTransfer) => void, thisArg?: any) {
    for (const [mimeType, item] of this.items.entries()) {
      callbackfn.call(thisArg, item, mimeType, this);
    }
  }

  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
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
    try {
      const parsed = new URL(value);
      return new Uri(
        parsed.protocol.replace(/:$/, ''),
        parsed.host,
        decodeURIComponent(parsed.pathname),
        parsed.search ? decodeURIComponent(parsed.search.slice(1)) : '',
        parsed.hash ? parsed.hash.slice(1) : ''
      );
    } catch {
      return new Uri('file', '', value, '', '');
    }
  }

  toString() {
    if (this.scheme === 'file') {
      return this.fsPath;
    }
    const query = this.query ? `?${this.query}` : '';
    const fragment = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
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

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export const TreeItemCheckboxState = {
  Unchecked: 0,
  Checked: 1,
};

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor
  ) {}
}

export class TreeItem {
  label?: string;
  id?: string;
  resourceUri?: Uri;
  collapsibleState?: number;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: any;
  command?: any;
  checkboxState?: any;

  constructor(label?: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const integrationEmitter = new EventEmitter<any>();
const terminalCloseEmitter = new EventEmitter<any>();
const executionEndEmitter = new EventEmitter<any>();

const state = {
  terminals: [] as any[],
  treeViews: [] as any[],
  executedCommands: [] as Array<{ command: string; args: any[] }>,
  registeredCommands: new Map<string, (...args: any[]) => any>(),
  contextValues: {} as Record<string, any>,
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

function createTreeView(id: string, options: any) {
  const checkboxEmitter = new EventEmitter<any>();
  const treeView = {
    id,
    options,
    selection: [] as any[],
    badge: undefined as any,
    description: undefined as any,
    __revealed: [] as any[],
    onDidChangeCheckboxState: checkboxEmitter.event,
    reveal(item: any) {
      treeView.__revealed.push(item);
      return Promise.resolve();
    },
    __fireCheckboxState(items: any[]) {
      checkboxEmitter.fire({ items });
    },
    dispose() {},
  };
  state.treeViews.push(treeView);
  return treeView;
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
  createTreeView,
  createTerminal,
  onDidChangeTerminalShellIntegration: integrationEmitter.event,
  onDidCloseTerminal: terminalCloseEmitter.event,
  onDidEndTerminalShellExecution: executionEndEmitter.event,
  activeTextEditor: undefined,
  showTextDocument: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
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
  registerTextDocumentContentProvider: () => ({
    dispose() {},
  }),
  fs: {
    stat: async () => ({
      type: FileType.Directory,
    }),
  },
};

export const commands = {
  executeCommand: async (command: string, ...args: any[]) => {
    state.executedCommands.push({ command, args });
    if (command === 'setContext') {
      state.contextValues[args[0]] = args[1];
      return undefined;
    }

    const handler = state.registeredCommands.get(command);
    return handler ? handler(...args) : undefined;
  },
  registerCommand: (name: string, callback: (...args: any[]) => any) => {
    state.registeredCommands.set(name, callback);
    return {
      dispose() {
        state.registeredCommands.delete(name);
      },
    };
  },
};

export function __resetMock() {
  state.terminals.length = 0;
  state.treeViews.length = 0;
  state.executedCommands.length = 0;
  state.registeredCommands.clear();
  state.contextValues = {};
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
