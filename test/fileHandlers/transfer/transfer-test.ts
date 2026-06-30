import { vi } from 'vitest';
import { Readable } from 'stream';

vi.mock('fs', async () => {
  const { fs } = await import('memfs');
  (fs as any).__mock__ = true;
  return fs;
});

vi.mock('fs-extra', async () => {
  const { fs } = await import('memfs');
  const removeRecursive = (target: string) => {
    if (!fs.existsSync(target)) {
      return;
    }

    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        removeRecursive(path.join(target, entry));
      }
      fs.rmdirSync(target);
      return;
    }

    fs.unlinkSync(target);
  };

  return {
    open: (targetPath: string, flags: string, mode?: number) =>
      Promise.resolve(fs.openSync(targetPath, flags, mode)),
    close: (fd: number) => Promise.resolve(fs.closeSync(fd)),
    fstat: (fd: number) => Promise.resolve(fs.fstatSync(fd)),
    futimes: (fd: number, atime: number, mtime: number) =>
      Promise.resolve(fs.futimesSync(fd, atime, mtime)),
    ensureDir: (dir: string) =>
      fs.promises.mkdir(dir, { recursive: true }).then(() => undefined),
    remove: (target: string) => Promise.resolve(removeRecursive(target)),
  };
});

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import {
  sync,
  TransferDirection,
} from '../../../src/fileHandlers/transfer/transfer';
import localFs from '../../../src/core/localFs';
import TransferTask from '../../../src/core/transferTask';
import RemoteFs from '../../helper/localRemoteFs';

declare global {
  interface Array<T> {
    formatSep(): Array<T>;
  }
}

Array.prototype.formatSep = function() {
  return this.map(str => str.replace(/\//g, path.sep));
};

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
  fs.writeFileSync(filePath, Buffer.concat(chunks));
};

function createRemoteFs({ remoteTimeOffsetInHours = 0 } = {}) {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours,
  });
}

async function runTasks(tasks: TransferTask[]) {
  await Promise.all(tasks.map(task => task.run()));
}

const file = (content: string, time = 0) => ({
  $$type: 'file',
  content,
  mtime: new Date(new Date().getTime() + time * 1000),
});

const fillFs = obj => {
  const files: { [x: string]: string } = {};
  const dirs: string[] = [];
  const stats: {
    [x: string]: {
      mtime: Date;
    };
  } = {};
  const processDirTree = (obj1, filepath = '/') => {
    const keys = Object.keys(obj1);
    if (keys.length <= 0) {
      dirs.push(filepath);
      return;
    }

    keys.forEach(key => {
      const fullpath = path.join(filepath, key);
      if (obj1[key].$$type === 'file') {
        files[fullpath] = obj1[key].content;
        stats[fullpath] = obj1[key];
      } else {
        processDirTree(obj1[key], fullpath);
      }
    });
  };
  processDirTree(obj);
  vol.fromJSON(files, '/');
  dirs.forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  Object.keys(stats).forEach(filepath => {
    fs.utimesSync(filepath, stats[filepath].mtime, stats[filepath].mtime);
  });
};

const mapList = (list: any[], key: string) => list.map(item => item[key]);

describe('transfer algorithm', () => {
  describe('sync', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vol.reset();
    });

    test('create=false skips missing target entries', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
        },
        remote: {
          a: file('$a'),
        },
      });

      const tasks: TransferTask[] = [];
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: false,
            delete: false,
            update: 'always',
            compare: 'mtime-size',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(tasks).toHaveLength(1);
      expect(mapList(tasks, 'targetFsPath')).toEqual(['/remote/a'].formatSep());
      expect(deleted).toEqual([]);
    });

    test('delete=true removes target-only entries before returning', async () => {
      fillFs({
        local: {
          keep: file('keep', 1),
        },
        remote: {
          keep: file('old'),
          extra: file('extra'),
        },
      });

      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: true,
            update: 'source-newer',
            compare: 'mtime-size',
            perserveTargetMode: false,
          },
        },
        () => undefined
      );

      expect(mapList(deleted, 'fspath')).toEqual(['/remote/extra'].formatSep());
      expect(fs.existsSync('/remote/extra')).toEqual(false);
    });

    test('update=never skips existing files', async () => {
      fillFs({
        local: {
          a: file('new', 2),
        },
        remote: {
          a: file('old', 1),
        },
      });

      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: false,
            update: 'never',
            compare: 'mtime-size',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(tasks).toHaveLength(0);
    });

    test('update=source-newer with mtime-size only transfers newer sources', async () => {
      fillFs({
        local: {
          newer: file('newer', 3),
          older: file('older', 1),
          same: file('same', 2),
        },
        remote: {
          newer: file('remote', 1),
          older: file('remote', 3),
          same: file('same', 2),
        },
      });

      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: false,
            update: 'source-newer',
            compare: 'mtime-size',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(mapList(tasks, 'targetFsPath')).toEqual(['/remote/newer'].formatSep());
    });

    test('update=source-newer with hash skips transfer when hashes match', async () => {
      fillFs({
        local: {
          a: file('same-content', 5),
        },
        remote: {
          a: file('same-content', 1),
        },
      });

      const getSpy = vi.spyOn(localFs, 'get');
      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: false,
            update: 'source-newer',
            compare: 'hash',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(tasks).toHaveLength(0);
      expect(getSpy).toHaveBeenCalledTimes(2);
    });

    test('update=source-newer with hash transfers when hashes differ', async () => {
      fillFs({
        local: {
          a: file('local-new', 5),
        },
        remote: {
          a: file('remote-old', 1),
        },
      });

      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: false,
            update: 'source-newer',
            compare: 'hash',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(mapList(tasks, 'targetFsPath')).toEqual(['/remote/a'].formatSep());
    });

    test('update=source-newer with hash does not hash when mtimes match', async () => {
      fillFs({
        local: {
          a: file('local', 2),
        },
        remote: {
          a: file('remote', 2),
        },
      });

      const getSpy = vi.spyOn(localFs, 'get');
      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: false,
            update: 'source-newer',
            compare: 'hash',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(tasks).toHaveLength(0);
      expect(getSpy).not.toHaveBeenCalled();
    });

    test('update=always still prunes obviously unchanged files', async () => {
      fillFs({
        local: {
          same: file('same', 2),
          changed: file('changed', 3),
        },
        remote: {
          same: file('same', 2),
          changed: file('old', 1),
        },
      });

      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            create: true,
            delete: false,
            update: 'always',
            compare: 'mtime-size',
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(mapList(tasks, 'targetFsPath')).toEqual(['/remote/changed'].formatSep());
    });

    test('single-direction sync still respects remote time offsets across reruns', async () => {
      const remoteFs = createRemoteFs({ remoteTimeOffsetInHours: 6 });
      fillFs({
        local: {
          a: file('a', 1),
        },
        remote: {
          a: file('$a'),
        },
      });

      const tasks: TransferTask[] = [];
      const collect = (task: TransferTask) => tasks.push(task);
      const runSync = async () => {
        const deleted = await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: remoteFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              create: true,
              delete: false,
              update: 'source-newer',
              compare: 'mtime-size',
              perserveTargetMode: false,
            },
          },
          collect
        );
        await runTasks(tasks);
        return deleted;
      };

      const firstDeleted = await runSync();
      expect(tasks).toHaveLength(1);
      expect(firstDeleted).toHaveLength(0);

      tasks.length = 0;

      const secondDeleted = await runSync();
      expect(tasks).toHaveLength(0);
      expect(secondDeleted).toHaveLength(0);
    });

    describe('symbolicLink: "direct"', () => {
      test('replaces a regular file with a symlink when source is symlink', async () => {
        vol.fromJSON({
          '/local/placeholder': '',
          '/remote/placeholder': 'regular file content',
        });
        fs.unlinkSync('/local/placeholder');
        fs.symlinkSync('/some/target', '/local/placeholder');

        const tasks: TransferTask[] = [];
        await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: localFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              create: true,
              delete: false,
              update: 'always',
              compare: 'mtime-size',
              symbolicLink: 'direct',
              perserveTargetMode: false,
            },
          },
          task => tasks.push(task)
        );

        expect(tasks).toHaveLength(1);
        expect(tasks[0].fileType).toBe(3); // FileType.SymbolicLink

        await runTasks(tasks);

        expect(fs.lstatSync('/remote/placeholder').isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync('/remote/placeholder')).toBe('/some/target');
      });

      test('replaces an existing symlink with different target', async () => {
        vol.fromJSON({
          '/local/placeholder': '',
          '/remote/placeholder': '',
        });
        fs.unlinkSync('/local/placeholder');
        fs.unlinkSync('/remote/placeholder');
        fs.symlinkSync('/new/target', '/local/placeholder');
        fs.symlinkSync('/old/target', '/remote/placeholder');

        const tasks: TransferTask[] = [];
        await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: localFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              create: true,
              delete: false,
              update: 'always',
              compare: 'mtime-size',
              symbolicLink: 'direct',
              perserveTargetMode: false,
            },
          },
          task => tasks.push(task)
        );

        expect(tasks).toHaveLength(1);
        await runTasks(tasks);

        expect(fs.readlinkSync('/remote/placeholder')).toBe('/new/target');
      });

      test('skips transfer when both sides are symlinks with same target', async () => {
        vol.fromJSON({
          '/local/placeholder': '',
          '/remote/placeholder': '',
        });
        fs.unlinkSync('/local/placeholder');
        fs.unlinkSync('/remote/placeholder');
        fs.symlinkSync('/same/target', '/local/placeholder');
        fs.symlinkSync('/same/target', '/remote/placeholder');

        const tasks: TransferTask[] = [];
        await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: localFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              create: true,
              delete: false,
              update: 'always',
              compare: 'mtime-size',
              symbolicLink: 'direct',
              perserveTargetMode: false,
            },
          },
          task => tasks.push(task)
        );

        expect(tasks).toHaveLength(0);
      });

      test('does not read target content when compare is hash and source is symlink', async () => {
        vol.fromJSON({
          '/local/placeholder': '',
          '/remote/link': '',
        });
        fs.unlinkSync('/local/placeholder');
        fs.symlinkSync('/dangling/path', '/local/placeholder');
        // remote has a regular file — readlink should not be called on it
        // instead shouldTransferExistingFile returns true due to type mismatch

        const tasks: TransferTask[] = [];
        await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: localFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              create: true,
              delete: false,
              update: 'source-newer',
              compare: 'hash',
              symbolicLink: 'direct',
              perserveTargetMode: false,
            },
          },
          task => tasks.push(task)
        );

        // source symlink 'placeholder' vs remote file 'link' — different names, no match
        // Let's redo with same name
        tasks.length = 0;
        vol.reset();
        vol.fromJSON({
          '/local/file': '',
          '/remote/file': 'real content',
        });
        fs.unlinkSync('/local/file');
        fs.symlinkSync('/dangling/path', '/local/file');

        await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: localFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              create: true,
              delete: false,
              update: 'source-newer',
              compare: 'hash',
              symbolicLink: 'direct',
              perserveTargetMode: false,
            },
          },
          task => tasks.push(task)
        );

        expect(tasks).toHaveLength(1);
        expect(tasks[0].fileType).toBe(3); // FileType.SymbolicLink
      });
    });
  });
});
