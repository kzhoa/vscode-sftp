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

export const window = {
  showErrorMessage: () => undefined,
  showInformationMessage: async () => undefined,
  createOutputChannel: () => ({
    appendLine() {},
    show() {},
    hide() {},
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

export default Nothing;
