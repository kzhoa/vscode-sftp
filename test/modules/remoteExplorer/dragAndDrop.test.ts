import { vi } from 'vitest';
import { Readable } from 'stream';

vi.mock('fs', async () => {
  const { fs } = await import('memfs');
  return fs;
});

vi.mock('fs-extra', async () => {
  const { fs } = await import('memfs');
  return {
    open: (targetPath: string, flags: string, mode?: number) =>
      Promise.resolve(fs.openSync(targetPath, flags, mode)),
    close: (fd: number) => Promise.resolve(fs.closeSync(fd)),
    fstat: (fd: number) => Promise.resolve(fs.fstatSync(fd)),
    futimes: (fd: number, atime: number, mtime: number) =>
      Promise.resolve(fs.futimesSync(fd, atime, mtime)),
    ensureDir: (dir: string) =>
      fs.promises.mkdir(dir, { recursive: true }).then(() => undefined),
    remove: (targetPath: string) => fs.promises.rm(targetPath, { recursive: true, force: true }),
    rename: (src: string, dest: string) => fs.promises.rename(src, dest),
  };
});

const { appMock } = vi.hoisted(() => ({
  appMock: {
    remoteExplorer: undefined as any,
    sftpBarItem: {
      createActivity: vi.fn(() => ({
        update() {},
        dispose() {},
      })),
    },
  },
}));

vi.mock('../../../src/app', () => ({
  default: appMock,
}));

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import {
  __getMockState,
  __resetMock,
  __setPendingMessageResult,
  DataTransfer,
  DataTransferItem,
  FileType as VSCodeFileType,
  Uri,
  workspace,
} from 'vscode';
import localFs from '../../../src/core/localFs';
import { FileSystem, UResource } from '../../../src/core';
import RemoteFs from '../../helper/localRemoteFs';
import RemoteExplorerDragAndDropController from '../../../src/modules/remoteExplorer/dragAndDropController';
import RemoteExplorerTransferService from '../../../src/modules/remoteExplorer/transferService';
import {
  normalizeRemoteDragSources,
  REMOTE_EXPLORER_TREE_MIME,
} from '../../../src/modules/remoteExplorer/dragAndDropTypes';

localFs.open = async (filePath: string, flags: string, mode?: number) =>
  fs.openSync(filePath, flags, mode);
localFs.close = async (fd: number) => {
  fs.closeSync(fd);
};
localFs.fstat = async (fd: number) => fs.fstatSync(fd) as any;
localFs.futimes = async (fd: number, atime: number, mtime: number) => {
  fs.futimesSync(fd, atime, mtime);
};
localFs.ensureDir = async (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
};
localFs.get = async (filePath: string) =>
  Readable.from(fs.readFileSync(filePath)) as any;
localFs.put = async (input: NodeJS.ReadableStream, filePath: string) => {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat(chunks));
};

function createRemoteFs() {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours: 0,
  });
}

function fillFs(entries: Record<string, string>) {
  vol.fromJSON(entries, '/');
}

function createRoot(remoteFs: FileSystem, configOverrides: Partial<any> = {}) {
  const fileService = {
    getLocalFileSystem: () => localFs,
    withRemoteFileSystem: async (_config: any, action: (fs: FileSystem) => Promise<any>) => action(remoteFs),
    createTransferScheduler: () => {
      const tasks: any[] = [];
      return {
        add(task: any) {
          tasks.push(task);
        },
        async run() {
          for (const task of tasks) {
            await task.run();
          }
        },
      };
    },
  };

  return {
    resource: UResource.makeResource({
      remote: { host: 'example.com', port: 22 },
      fsPath: '/remote',
      remoteId: 1,
    }),
    isDirectory: true,
    explorerContext: {
      fileService,
      config: {
        protocol: 'sftp',
        filePerm: undefined,
        dirPerm: undefined,
        useTempFile: false,
        openSsh: false,
        ignore: undefined,
        concurrency: 4,
        ...configOverrides,
      },
      id: 1,
      profile: null,
    },
  };
}

function createController(root: any) {
  const provider = {
    findRoot: vi.fn(() => root),
  } as any;
  const controller = new RemoteExplorerDragAndDropController(provider);
  appMock.remoteExplorer = {
    refresh: vi.fn(),
    findRoot: vi.fn(() => root),
  };
  return { controller, provider };
}

function createRemoteItem(root: any, remotePath: string, isDirectory = false) {
  return {
    resource: UResource.updateResource(root.resource, { remotePath }),
    isDirectory,
  };
}

describe('RemoteExplorerDragAndDropController', () => {
  beforeEach(() => {
    vol.reset();
    __resetMock();
    __setPendingMessageResult(undefined);
    (workspace.fs as any).stat = async (uri: Uri) => {
      if (!fs.existsSync(uri.fsPath)) {
        throw new Error(`Missing mocked path for workspace.fs.stat: ${uri.fsPath}`);
      }
      return {
        type: fs.statSync(uri.fsPath).isDirectory() ? VSCodeFileType.Directory : VSCodeFileType.File,
      };
    };
  });

  test('handleDrag writes remote payload and uri list', async () => {
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const file = createRemoteItem(root, '/remote/file.txt', false);
    const transfer = new DataTransfer();

    controller.handleDrag([file], transfer);

    expect(transfer.get(REMOTE_EXPLORER_TREE_MIME)?.value).toEqual([
      expect.objectContaining({
        remotePath: '/remote/file.txt',
        isDirectory: false,
      }),
    ]);
    expect(await transfer.get('text/uri-list')?.asString()).toContain('remote://');
  });

  test('handleDrop rejects moving a folder into its own descendant', async () => {
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const source = createRemoteItem(root, '/remote/folder', true);
    const target = createRemoteItem(root, '/remote/folder/child', true);
    const transfer = new DataTransfer();
    transfer.set(REMOTE_EXPLORER_TREE_MIME, new DataTransferItem([
      {
        remoteUri: source.resource.uri.toString(),
        remotePath: source.resource.fsPath,
        isDirectory: true,
        remoteId: 1,
      },
    ]));

    await controller.handleDrop(target, transfer);

    expect(__getMockState().errorMessages.at(-1)?.message).toContain('Cannot move a remote folder into itself');
  });

  test('handleDrop uploads local files and skips conflicts in one batch', async () => {
    fillFs({
      '/local/a.txt': 'new-a',
      '/local/b.txt': 'new-b',
      '/remote/target/a.txt': 'old-a',
    });
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const target = createRemoteItem(root, '/remote/target', true);
    const transfer = new DataTransfer();
    transfer.set('text/uri-list', new DataTransferItem([
      Uri.file('/local/a.txt').toString(),
      Uri.file('/local/b.txt').toString(),
    ].join('\r\n')));
    __setPendingMessageResult('Skip Conflicts');

    await controller.handleDrop(target, transfer);

    expect(fs.readFileSync('/remote/target/a.txt', 'utf8')).toEqual('old-a');
    expect(fs.readFileSync('/remote/target/b.txt', 'utf8')).toEqual('new-b');
  });

  test('handleDrop moves remote items within the same root', async () => {
    fillFs({
      '/remote/src/file.txt': 'payload',
    });
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const source = createRemoteItem(root, '/remote/src/file.txt', false);
    const target = createRemoteItem(root, '/remote/dest', true);
    fs.mkdirSync('/remote/dest', { recursive: true });
    const transfer = new DataTransfer();
    transfer.set(REMOTE_EXPLORER_TREE_MIME, new DataTransferItem([
      {
        remoteUri: source.resource.uri.toString(),
        remotePath: source.resource.fsPath,
        isDirectory: false,
        remoteId: 1,
      },
    ]));

    await controller.handleDrop(target, transfer);

    expect(fs.existsSync('/remote/src/file.txt')).toEqual(false);
    expect(fs.readFileSync('/remote/dest/file.txt', 'utf8')).toEqual('payload');
    expect(appMock.remoteExplorer.refresh).toHaveBeenCalled();
  });

  test('downloadToLocalDirectory accepts directory symlinks as local targets', async () => {
    fillFs({
      '/remote/file.txt': 'payload',
    });
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const source = createRemoteItem(root, '/remote/file.txt', false);
    fs.mkdirSync('/local-link', { recursive: true });
    (workspace.fs as any).stat = async () => ({
      type: VSCodeFileType.Directory | VSCodeFileType.SymbolicLink,
    });

    await controller.downloadToLocalDirectory(Uri.file('/local-link'), [source]);

    expect(fs.readFileSync('/local-link/file.txt', 'utf8')).toEqual('payload');
  });

  test('handleDrop rejects dropping a remote item into its current parent folder', async () => {
    fillFs({
      '/remote/src/file.txt': 'payload',
    });
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const source = createRemoteItem(root, '/remote/src/file.txt', false);
    const target = createRemoteItem(root, '/remote/src', true);
    const transfer = new DataTransfer();
    transfer.set(REMOTE_EXPLORER_TREE_MIME, new DataTransferItem([
      {
        remoteUri: source.resource.uri.toString(),
        remotePath: source.resource.fsPath,
        isDirectory: false,
        remoteId: 1,
      },
    ]));

    await controller.handleDrop(target, transfer);

    expect(fs.readFileSync('/remote/src/file.txt', 'utf8')).toEqual('payload');
    expect(__getMockState().errorMessages.at(-1)?.message).toContain('already in this folder');
  });

  test('downloadToLocalDirectory downloads remote files to a local directory', async () => {
    fillFs({
      '/remote/file.txt': 'from-remote',
    });
    fs.mkdirSync('/downloads', { recursive: true });
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const source = createRemoteItem(root, '/remote/file.txt', false);

    await controller.downloadToLocalDirectory(Uri.file('/downloads'), [source]);

    expect(fs.readFileSync('/downloads/file.txt', 'utf8')).toEqual('from-remote');
  });

  test('downloadToLocalDirectory reports local target validation errors', async () => {
    const root = createRoot(createRemoteFs());
    const { controller } = createController(root);
    const source = createRemoteItem(root, '/remote/file.txt', false);

    await controller.downloadToLocalDirectory(Uri.file('/missing-downloads'), [source]);

    expect(__getMockState().errorMessages.at(-1)?.message).toContain(
      'Missing mocked path for workspace.fs.stat: /missing-downloads'
    );
  });

  test('collectConflicts scans directory trees with bounded concurrency', async () => {
    fillFs({
      '/local/batch/file-1.txt': 'a',
      '/local/batch/file-2.txt': 'b',
      '/local/batch/file-3.txt': 'c',
      '/local/batch/file-4.txt': 'd',
      '/local/batch/file-5.txt': 'e',
      '/local/batch/file-6.txt': 'f',
      '/remote/target/batch/file-1.txt': 'old-a',
      '/remote/target/batch/file-2.txt': 'old-b',
      '/remote/target/batch/file-3.txt': 'old-c',
      '/remote/target/batch/file-4.txt': 'old-d',
      '/remote/target/batch/file-5.txt': 'old-e',
      '/remote/target/batch/file-6.txt': 'old-f',
    });
    const remoteFs = createRemoteFs();
    const originalLstat = remoteFs.lstat.bind(remoteFs);
    let inflight = 0;
    let maxInflight = 0;
    Object.defineProperty(remoteFs, 'lstat', {
      configurable: true,
      value: async (targetPath: string) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise(resolve => setTimeout(resolve, 10));
        try {
          return await originalLstat(targetPath);
        } finally {
          inflight -= 1;
        }
      },
    });

    const root = createRoot(remoteFs, { concurrency: 99 });
    const service = new RemoteExplorerTransferService();

    const conflicts = await service.collectConflicts({
      operation: 'upload',
      targetRoot: root,
      targetDirectory: '/remote/target',
      uploads: [
        {
          sourceUri: Uri.file('/local/batch'),
          sourcePath: '/local/batch',
          targetPath: '/remote/target/batch',
        },
      ],
    });

    expect(conflicts).toHaveLength(6);
    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBeLessThanOrEqual(8);
  });

  test('normalizeRemoteDragSources deduplicates descendants when remote paths contain colons', () => {
    const root = createRoot(createRemoteFs());
    const parent = createRemoteItem(root, '/remote/folder:one', true);
    const child = createRemoteItem(root, '/remote/folder:one/file.txt', false);

    const normalized = normalizeRemoteDragSources([child, parent]);

    expect(normalized).toEqual([parent]);
  });
});
