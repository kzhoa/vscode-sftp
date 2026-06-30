import { vi, beforeEach } from 'vitest';

const { fsMock, fsCacheMock, loggerMock } = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  fsCacheMock: {
    has: vi.fn(() => false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  },
  loggerMock: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', () => fsMock);
vi.mock('../../src/fsCache', () => ({ default: fsCacheMock }));
vi.mock('../../src/logger', () => ({ default: loggerMock }));

import { defaultConfigSource } from '../../src/modules/configSourceImpl';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('defaultConfigSource.readOptional', () => {
  test('returns null silently on ENOENT', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    fsMock.readFileSync.mockImplementation(() => { throw err; });

    const result = defaultConfigSource.readOptional('/missing/file');

    expect(result).toBeNull();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  test('returns null and warns on EACCES', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    fsMock.readFileSync.mockImplementation(() => { throw err; });

    const result = defaultConfigSource.readOptional('/protected/file');

    expect(result).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('/protected/file')
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('permission denied')
    );
  });

  test('returns null and warns on unexpected IO error', () => {
    const err = Object.assign(new Error('device not ready'), { code: 'EIO' });
    fsMock.readFileSync.mockImplementation(() => { throw err; });

    const result = defaultConfigSource.readOptional('/bad/device');

    expect(result).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('/bad/device')
    );
  });

  test('returns content on success', () => {
    fsMock.readFileSync.mockReturnValue('file content');

    const result = defaultConfigSource.readOptional('/good/file');

    expect(result).toEqual('file content');
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(fsCacheMock.set).toHaveBeenCalledWith('/good/file', 'file content');
  });
});
