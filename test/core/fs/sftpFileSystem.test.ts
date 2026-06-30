import path from 'node:path';
import { PassThrough } from 'node:stream';
import SFTPFileSystem from '../../../src/core/fs/sftpFileSystem';
import { FileType } from '../../../src/core/fs/fileSystem';
import { createFakeRemoteClient } from '../../helper/fakeRemoteClient';

describe('SFTPFileSystem', () => {
  test('fstat falls back to stat when fstat is unsupported', async () => {
    const fsClient = {
      fstat: (_handle, callback) => callback(new Error('unsupported')),
      stat: vi.fn((_path, callback) =>
        callback(null, {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o764,
          size: 12,
          mtime: 10,
          atime: 9,
        })
      ),
    };

    const fileSystem = new SFTPFileSystem(path.posix, {
      client: createFakeRemoteClient(fsClient) as any,
    });

    const stat = await fileSystem.fstat({
      handle: Buffer.from('1'),
      path: '/remote/file.txt',
    });

    expect(fsClient.stat).toHaveBeenCalledWith('/remote/file.txt', expect.any(Function));
    expect(stat.type).toEqual(FileType.File);
    expect(stat.mode).toEqual(0o764);
  });

  test('fchmod falls back to chmod when fchmod fails', async () => {
    const fsClient = {
      fchmod: (_handle, _mode, callback) => callback(new Error('unsupported')),
      chmod: vi.fn((_path, _mode, callback) => callback(null)),
    };
    const fileSystem = new SFTPFileSystem(path.posix, {
      client: createFakeRemoteClient(fsClient) as any,
    });

    await fileSystem.fchmod(
      { handle: Buffer.from('1'), path: '/remote/file.txt' },
      0o644
    );

    expect(fsClient.chmod).toHaveBeenCalledWith('/remote/file.txt', 0o644, expect.any(Function));
  });

  test('ensureDir creates parent directories recursively', async () => {
    const calls: string[] = [];
    const fsClient = {
      mkdir: (dir, callback) => {
        calls.push(dir);
        if (dir === '/parent/child' && calls.filter(call => call === dir).length === 1) {
          callback({ code: 2 });
          return;
        }
        callback(null);
      },
    };
    const fileSystem = new SFTPFileSystem(path.posix, {
      client: createFakeRemoteClient(fsClient) as any,
    });

    await fileSystem.ensureDir('/parent/child');

    expect(calls).toEqual(['/parent/child', '/parent', '/parent/child']);
  });

  test('put applies mode when fd is provided', async () => {
    const writer = new PassThrough() as PassThrough & {
      handle: Buffer;
      path: string;
      flags: string;
      mode: number;
      close(): void;
    };
    writer.handle = Buffer.from('1');
    writer.path = '/remote/file.txt';
    writer.flags = 'w';
    writer.mode = 0o644;
    writer.close = () => undefined;

    const fsClient = {
      createWriteStream: vi.fn(() => writer),
    };
    const fileSystem = new SFTPFileSystem(path.posix, {
      client: createFakeRemoteClient(fsClient) as any,
    });
    const chmodSpy = vi.spyOn(fileSystem, 'fchmod').mockResolvedValue();

    const input = new PassThrough();
    input.end('content');

    await fileSystem.put(input, '/remote/file.txt', {
      fd: { handle: Buffer.from('1'), path: '/remote/file.txt' } as any,
      mode: 0o644,
    });

    expect(chmodSpy).toHaveBeenCalled();
  });

  test('put rejects when the input stream errors', async () => {
    const writer = new PassThrough() as PassThrough & {
      handle: Buffer;
      path: string;
      flags: string;
      mode: number;
      close(): void;
    };
    writer.handle = Buffer.from('1');
    writer.path = '/remote/file.txt';
    writer.flags = 'w';
    writer.mode = 0o644;
    writer.close = () => undefined;

    const fsClient = {
      createWriteStream: () => writer,
    };
    const fileSystem = new SFTPFileSystem(path.posix, {
      client: createFakeRemoteClient(fsClient) as any,
    });

    const input = new PassThrough();
    const endSpy = vi.spyOn(writer, 'end');
    const result = fileSystem.put(input, '/remote/file.txt');
    input.emit('error', new Error('boom'));

    await expect(result).rejects.toThrow('boom');
    expect(endSpy).toHaveBeenCalled();
  });
});
