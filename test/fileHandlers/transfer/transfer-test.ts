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
    open: (path: string, flags: string, mode?: number) => Promise.resolve(fs.openSync(path, flags, mode)),
    close: (fd: number) => Promise.resolve(fs.closeSync(fd)),
    fstat: (fd: number) => Promise.resolve(fs.fstatSync(fd)),
    futimes: (fd: number, atime: number, mtime: number) => Promise.resolve(fs.futimesSync(fd, atime, mtime)),
    ensureDir: (dir: string) => fs.promises.mkdir(dir, { recursive: true }).then(() => undefined),
    remove: (target: string) => Promise.resolve(removeRecursive(target)),
  };
});

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import { sync, TransferDirection } from '../../../src/fileHandlers/transfer/transfer';
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

localFs.open = async (filePath: string, flags: string, mode?: number) => fs.openSync(filePath, flags, mode);
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
localFs.get = async (filePath: string) => Readable.from(fs.readFileSync(filePath)) as any;
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
  return Promise.all(
    tasks.map(async task => {
      try {
        await task.run();
      } catch (error) {
        console.log('run task fail', error);
      }
    })
  );
}

const file = (c, time = 0) => ({
  $$type: 'file',
  content: c,
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
const mapList = (list: any[], key: string) => list.map(t => t[key]);

describe('transfer algorithm', () => {
  describe('sync', () => {
    afterEach(() => {
      vol.reset();
    });

    test('sync', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --delete', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(3);
      expect(mapList(deleted, 'fspath').sort()).toEqual(
        ['/remote/$da', '/remote/$db', '/remote/c/$dc'].formatSep().sort()
      );
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --update', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(3);
      expect(mapList(deleted, 'fspath').sort()).toEqual(
        ['/remote/$da', '/remote/$db', '/remote/c/$dc'].formatSep().sort()
      );
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --update with time offset', async () => {
      const remoteFs = createRemoteFs({ remoteTimeOffsetInHours: 6 });
      fillFs({
        local: {
          a: file('a', 1),
        },
        remote: {
          a: file('$a'),
        },
      });
      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      let deleted;
      const runSync = async () => {
        deleted = await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: remoteFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              skipCreate: true,
              delete: false,
              perserveTargetMode: false,
            },
          },
          collect
        );
        await runTasks(task);
      };
      await runSync();
      expect(task.length).toEqual(1);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a'].formatSep().sort()
      );
      task.length = 0;
      deleted.length = 0;
      await runSync();
      expect(task.length).toEqual(0);
      expect(deleted.length).toEqual(0);
    });

    test('sync --skipDelete', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          c: {
            'c-a': file('$c-a'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            skipCreate: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(3);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a', '/remote/c/c-a', '/remote/c/d/d-a'].formatSep().sort()
      );
    });

    test('sync --update', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a', 2),
          c: {
            'c-a': file('$c-a', 1),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            update: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(4);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/b',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync both direction"', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            'c-c': file('c-c', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          b: file('$b', 2),
          c: {
            'c-a': file('$c-a'),
            'c-b': file('$c-b', 2),
            d: {
              'd-a': file('$d-a'),
              'd-b': file('$d-b', 2),
              'd-c': file('$d-c'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            bothDiretions: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(8);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/local/b',
          '/remote/c/c-a',
          '/local/c/c-b',
          '/remote/c/c-c',
          '/remote/c/d/d-a',
          '/local/c/d/d-b',
          '/local/c/d/d-c',
        ].formatSep().sort()
      );
    });

    test('sync both direction --skipCreate"', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            'c-c': file('c-c', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          b: file('$b', 2),
          c: {
            'c-a': file('$c-a'),
            'c-b': file('$c-b', 2),
            d: {
              'd-a': file('$d-a'),
              'd-b': file('$d-b', 2),
              'd-c': file('$d-c'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            skipCreate: true,
            bothDiretions: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/local/b',
          '/remote/c/c-a',
          '/local/c/c-b',
          '/remote/c/d/d-a',
          '/local/c/d/d-b',
        ].formatSep().sort()
      );
    });
  });
});
