import path from 'node:path';
import { PassThrough } from 'node:stream';
import FTPFileSystem from '../../../src/core/fs/ftpFileSystem';
import { FileType } from '../../../src/core/fs/fileSystem';
import { createFakeRemoteClient } from '../../helper/fakeRemoteClient';

describe('FTPFileSystem', () => {
  test('toFileStat converts ftp listings to FileStats', () => {
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient({}) as any,
    });

    const stat = fileSystem.toFileStat({
      type: '-',
      rights: {
        user: 'rw',
        group: 'r',
        other: 'r',
      },
      size: 20,
      date: new Date(10_000),
      target: undefined,
    });

    expect(stat.type).toEqual(FileType.File);
    expect(stat.mode).toEqual(0o644);
    expect(stat.size).toEqual(20);
  });

  test('lstat returns a virtual root entry for /', async () => {
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient({}) as any,
    });

    await expect(fileSystem.lstat('/')).resolves.toMatchObject({
      type: FileType.Directory,
      mode: 0o666,
    });
  });

  test('ensureDir short-circuits when directory already exists', async () => {
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient({}) as any,
    });
    const mkdirSpy = vi.spyOn(fileSystem, 'mkdir');
    vi.spyOn(fileSystem, 'lstat').mockResolvedValue({
      type: FileType.Directory,
      mode: 0o755,
      size: 0,
      mtime: 0,
      atime: 0,
    });

    await fileSystem.ensureDir('/existing');

    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  test('ensureDir creates parents recursively after 550 errors', async () => {
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient({}) as any,
    });
    vi.spyOn(fileSystem, 'lstat').mockRejectedValue(new Error('missing'));
    const mkdirSpy = vi
      .spyOn(fileSystem, 'mkdir')
      .mockRejectedValueOnce({ code: 550, message: 'missing parent' })
      .mockResolvedValueOnce()
      .mockResolvedValueOnce();

    await fileSystem.ensureDir('/parent/child');

    expect(mkdirSpy).toHaveBeenNthCalledWith(1, '/parent/child');
    expect(mkdirSpy).toHaveBeenNthCalledWith(2, '/parent');
    expect(mkdirSpy).toHaveBeenNthCalledWith(3, '/parent/child');
  });

  test('futimes stops retrying MFMT after the first failure', async () => {
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient({}) as any,
    });
    const setLastModSpy = vi
      .spyOn(fileSystem as any, 'atomicSetLastMod')
      .mockRejectedValueOnce(new Error('no MFMT'));

    await fileSystem.futimes({ path: '/a', flags: 'w' } as any, 0, 1);
    await fileSystem.futimes({ path: '/a', flags: 'w' } as any, 0, 1);

    expect(setLastModSpy).toHaveBeenCalledTimes(1);
  });

  test('list filters invalid and dot entries', async () => {
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient({}) as any,
    });
    vi.spyOn(fileSystem as any, 'atomicList').mockResolvedValue([
      '.',
      { name: '.', type: 'd', rights: {}, size: 0, date: new Date() },
      { name: '..', type: 'd', rights: {}, size: 0, date: new Date() },
      { name: 'file.txt', type: '-', rights: { user: 'rw', group: 'r', other: 'r' }, size: 1, date: new Date() },
    ]);

    const entries = await fileSystem.list('/root');

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toEqual('file.txt');
  });

  test('put aborts and surfaces input errors', async () => {
    const ftpClient = {
      abort: vi.fn(callback => callback(null)),
    };
    const fileSystem = new FTPFileSystem(path.posix, {
      client: createFakeRemoteClient(ftpClient) as any,
    });
    vi.spyOn(fileSystem as any, 'atomicPut').mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('write failed')), 0);
        })
    );

    const input = new PassThrough();
    const promise = fileSystem.put(input, '/remote/file.txt');
    input.emit('error', new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
    expect(ftpClient.abort).toHaveBeenCalled();
  });
});
