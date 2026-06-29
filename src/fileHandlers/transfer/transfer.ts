import { createHash } from 'crypto';
import {
  FileSystem,
  FileEntry,
  FileType,
  TransferTask,
  TransferOption as TransferTaskTransferOption,
  TransferDirection,
  fileOperations,
} from '../../core';
import { FileHandleOption } from '../option';
import logger from '../../logger';
import { getOpenTextDocuments } from '../../host';
import {
  type ResolvedSyncOption,
  type SyncCompareMode,
  type SyncUpdateMode,
} from '../../core/syncOption';

interface InternalTransferOption
  extends FileHandleOption,
    TransferTaskTransferOption {}

type ExternalTransferOption<T extends InternalTransferOption> = Pick<
  T,
  Exclude<keyof T, 'mtime' | 'atime' | 'mode' | 'fallbackMode'>
>;

type TransferOption = ExternalTransferOption<InternalTransferOption>;

interface SyncOption extends TransferOption, ResolvedSyncOption {
  bothDiretions?: boolean;
}

interface BaseTransferHandleConfig {
  srcFsPath: string;
  targetFsPath: string;
  dirPerm?: number;
  filePerm?: number;
  srcFs: FileSystem;
  targetFs: FileSystem;
  transferDirection: TransferDirection;
}

interface TransferHandleConfig<T> extends BaseTransferHandleConfig {
  transferOption: T;
}

function getAltDirection(direction: TransferDirection) {
  return direction === TransferDirection.LOCAL_TO_REMOTE
    ? TransferDirection.REMOTE_TO_LOCAL
    : TransferDirection.LOCAL_TO_REMOTE;
}

function isFileModified(a: FileEntry, b: FileEntry): boolean {
  return (
    Math.floor(a.mtime / 1000) !== Math.floor(b.mtime / 1000) ||
    a.size !== b.size
  );
}

function toHash<T, R = T>(
  items: T[],
  key: string,
  transform?: (a: T) => R
): { [key: string]: R } {
  return items.reduce((hash, item) => {
    const transformedItem = transform ? transform(item) : item;
    hash[transformedItem[key]] = transformedItem;
    return hash;
  }, {});
}

async function computeFileHash(fs: FileSystem, fsPath: string): Promise<string> {
  const stream = await fs.get(fsPath);
  const hash = createHash('sha256');

  return new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      hash.update(chunk);
    });
    stream.once('end', () => resolve(hash.digest('hex')));
    stream.once('error', reject);
  });
}

export function shouldTransferExistingFileForAlways(
  srcFile: FileEntry,
  targetFile: FileEntry
): boolean {
  return isFileModified(srcFile, targetFile);
}

export function shouldTransferExistingFileForSourceNewerWithMtimeSize(
  srcFile: FileEntry,
  targetFile: FileEntry
): boolean {
  if (srcFile.mtime <= targetFile.mtime) {
    return false;
  }

  return isFileModified(srcFile, targetFile);
}

export async function shouldTransferExistingFileForSourceNewerWithHash(
  srcFs: FileSystem,
  srcFile: FileEntry,
  targetFs: FileSystem,
  targetFile: FileEntry
): Promise<boolean> {
  if (srcFile.mtime === targetFile.mtime) {
    return false;
  }

  const [srcHash, targetHash] = await Promise.all([
    computeFileHash(srcFs, srcFile.fspath),
    computeFileHash(targetFs, targetFile.fspath),
  ]);

  return srcHash !== targetHash;
}

async function shouldTransferExistingFile(
  srcFs: FileSystem,
  srcFile: FileEntry,
  targetFs: FileSystem,
  targetFile: FileEntry,
  update: SyncUpdateMode,
  compare: SyncCompareMode
): Promise<boolean> {
  if (update === 'never') {
    return false;
  }

  if (update === 'always') {
    return shouldTransferExistingFileForAlways(srcFile, targetFile);
  }

  if (compare === 'hash') {
    return shouldTransferExistingFileForSourceNewerWithHash(
      srcFs,
      srcFile,
      targetFs,
      targetFile
    );
  }

  return shouldTransferExistingFileForSourceNewerWithMtimeSize(
    srcFile,
    targetFile
  );
}

async function transferFolder(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption } = config;

  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  await targetFs.ensureDir(targetFsPath);

  if (config.transferOption.dirPerm) {
    logger.info(
      'chmod remote directory as configured by dirPerm, dirPerm is: ',
      config.transferOption.dirPerm
    );
    await targetFs.chmod(
      targetFsPath,
      parseInt(String(config.transferOption.dirPerm), 8)
    );
  }

  const fileEntries = await srcFs.list(srcFsPath);
  await Promise.all(
    fileEntries.map(file =>
      transferWithType(
        {
          ...config,
          transferOption: {
            ...config.transferOption,
            mtime: file.mtime,
            atime: file.atime,
          },
          srcFsPath: file.fspath,
          targetFsPath: targetFs.pathResolver.join(targetFsPath, file.name),
          ensureDirExist: false,
        },
        file.type,
        collect
      )
    )
  );

  logger.info('folder transfered.');
}

async function transferFile(
  config: TransferHandleConfig<InternalTransferOption>,
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  if (
    config.transferOption.ignore &&
    config.transferOption.ignore(config.srcFsPath)
  ) {
    return;
  }

  collect(
    new TransferTask(
      {
        fsPath: config.srcFsPath,
        fileSystem: config.srcFs,
      },
      {
        fsPath: config.targetFsPath,
        fileSystem: config.targetFs,
      },
      {
        fileType,
        transferDirection: config.transferDirection,
        transferOption: config.transferOption,
      }
    )
  );
}

async function transferWithType(
  config: TransferHandleConfig<InternalTransferOption> & {
    ensureDirExist: boolean;
  },
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  switch (fileType) {
    case FileType.Directory:
      await transferFolder(config, collect);
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      if (config.ensureDirExist) {
        const { targetFs, targetFsPath } = config;
        await targetFs.ensureDir(targetFs.pathResolver.dirname(targetFsPath));
        if (config.transferOption.dirPerm) {
          logger.info(
            'Running chmod on remote directory with perm: ',
            config.transferOption.dirPerm
          );
          await targetFs.chmod(
            targetFs.pathResolver.dirname(targetFsPath),
            parseInt(String(config.transferOption.dirPerm), 8)
          );
        }
      }
      if (config.transferDirection === TransferDirection.LOCAL_TO_REMOTE) {
        const textDocuments = getOpenTextDocuments();
        const document = textDocuments.find(
          doc => doc.fileName === config.srcFsPath
        );
        if (document && !document.isClosed && document.isDirty) {
          await document.save();
          const stat = await config.srcFs.lstat(config.srcFsPath);
          config.transferOption.mtime = stat.mtime;
          logger.info('save before upload.');
        }
      }
      transferFile(config, fileType, collect);
      break;
    default:
      logger.warn(
        `Unsupported file type (type = ${fileType}). File ${config.srcFsPath}`
      );
  }
}

async function removeFile(
  file: string,
  fs: FileSystem,
  fileType: FileType,
  option
) {
  if (option.ignore && option.ignore(file)) {
    return;
  }

  switch (fileType) {
    case FileType.Directory:
      await fileOperations.removeDir(file, fs, option);
      logger.info('folder removed.');
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      await fileOperations.removeFile(file, fs, option);
      logger.info('file removed.');
      break;
    default:
      break;
  }
}

async function _sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void,
  deleted: FileEntry[]
) {
  const {
    srcFsPath,
    targetFsPath,
    srcFs,
    targetFs,
    transferOption,
    transferDirection,
  } = config;
  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  const altDirection = getAltDirection(transferDirection);

  const syncFiles = async (srcFileEntries: FileEntry[], desFileEntries: FileEntry[]) => {
    const srcFileTable = toHash(srcFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const desFileTable = toHash(desFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const ignoreSymlink = transferOption.symbolicLink === 'ignore';
    const resolveSymlink = transferOption.symbolicLink === 'resolve';

    const file2trans: Array<
      [string, string, TransferDirection, InternalTransferOption, FileType]
    > = [];
    const dir2trans: Array<[string, string]> = [];
    const dir2sync: Array<[string, string]> = [];
    const removalTasks: Promise<void>[] = [];

    for (const id of Object.keys(srcFileTable)) {
      const srcFile = srcFileTable[id];
      const desFile = desFileTable[id];
      delete desFileTable[id];

      if (desFile) {
        let from: FileEntry = srcFile;
        let to: FileEntry = desFile;
        let direction: TransferDirection = transferDirection;

        if (srcFile.type === FileType.Directory) {
          dir2sync.push([srcFile.fspath, desFile.fspath]);
          continue;
        }

        if (srcFile.type !== FileType.File && srcFile.type !== FileType.SymbolicLink) {
          continue;
        }

        const isSymlink = srcFile.type === FileType.SymbolicLink;
        const transferType = isSymlink && resolveSymlink
          ? FileType.File
          : srcFile.type;

        if (isSymlink && ignoreSymlink) {
          continue;
        }

        if (transferOption.bothDiretions && desFile.mtime > srcFile.mtime) {
          from = desFile;
          to = srcFile;
          direction = altDirection;
        }

        const shouldTransfer = await shouldTransferExistingFile(
          direction === transferDirection ? srcFs : targetFs,
          from,
          direction === transferDirection ? targetFs : srcFs,
          to,
          transferOption.update,
          transferOption.compare
        );

        if (!shouldTransfer) {
          continue;
        }

        file2trans.push([
          from.fspath,
          to.fspath,
          direction,
          {
            ...transferOption,
            mode: to.mode,
            mtime: from.mtime,
            atime: from.atime,
          },
          transferType,
        ]);
        continue;
      }

      if (!transferOption.create) {
        continue;
      }

      const fspath = targetFs.pathResolver.join(targetFsPath, srcFile.name);
      switch (srcFile.type) {
        case FileType.Directory:
          dir2trans.push([srcFile.fspath, fspath]);
          break;
        case FileType.File:
          file2trans.push([
            srcFile.fspath,
            fspath,
            transferDirection,
            {
              ...transferOption,
              fallbackMode: srcFile.mode,
              mtime: srcFile.mtime,
              atime: srcFile.atime,
            },
            FileType.File,
          ]);
          break;
        case FileType.SymbolicLink: {
          if (ignoreSymlink) {
            break;
          }
          const createType = resolveSymlink
            ? FileType.File
            : FileType.SymbolicLink;
          file2trans.push([
            srcFile.fspath,
            fspath,
            transferDirection,
            {
              ...transferOption,
              fallbackMode: srcFile.mode,
              mtime: srcFile.mtime,
              atime: srcFile.atime,
            },
            createType,
          ]);
          break;
        }
        default:
      }
    }

    if (transferOption.bothDiretions) {
      if (transferOption.create) {
        Object.keys(desFileTable).forEach(id => {
          const file = desFileTable[id];
          const fspath = srcFs.pathResolver.join(srcFsPath, file.name);
          switch (file.type) {
            case FileType.Directory:
              dir2trans.push([file.fspath, fspath]);
              break;
            case FileType.File:
              file2trans.push([
                file.fspath,
                fspath,
                altDirection,
                {
                  ...transferOption,
                  fallbackMode: file.mode,
                  mtime: file.mtime,
                  atime: file.atime,
                },
                FileType.File,
              ]);
              break;
            case FileType.SymbolicLink: {
              if (ignoreSymlink) {
                break;
              }
              const createType = resolveSymlink
                ? FileType.File
                : FileType.SymbolicLink;
              file2trans.push([
                file.fspath,
                fspath,
                altDirection,
                {
                  ...transferOption,
                  fallbackMode: file.mode,
                  mtime: file.mtime,
                  atime: file.atime,
                },
                createType,
              ]);
              break;
            }
            default:
          }
        });
      }
    } else if (transferOption.delete) {
      Object.keys(desFileTable).forEach(id => {
        const file = desFileTable[id];
        if (file.type === FileType.SymbolicLink && ignoreSymlink) {
          return;
        }
        deleted.push(file);
        removalTasks.push(removeFile(file.fspath, targetFs, file.type, transferOption));
      });
    }

    await Promise.all(removalTasks);

    await Promise.all(
      file2trans.map(([src, target, direction, option, fileType]) =>
        transferFile(
          {
            ...config,
            transferDirection: direction,
            transferOption: option,
            srcFsPath: src,
            targetFsPath: target,
          },
          fileType,
          collect
        )
      )
    );

    await Promise.all(
      dir2trans.map(([src, target]) =>
        transferFolder(
          {
            ...config,
            srcFsPath: src,
            targetFsPath: target,
          },
          collect
        )
      )
    );

    await Promise.all(
      dir2sync.map(([src, target]) =>
        _sync(
          {
            ...config,
            srcFsPath: src,
            targetFsPath: target,
          },
          collect,
          deleted
        )
      )
    );
  };

  await targetFs.ensureDir(targetFsPath);

  const files = await Promise.all([
    srcFs.list(srcFsPath).catch(_err => []),
    targetFs.list(targetFsPath).catch(_err => []),
  ]);
  await syncFiles(...files);
}

export { TransferOption, SyncOption, TransferDirection };

export async function transfer(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const stat = await config.srcFs.lstat(config.srcFsPath);
  const transferOption = {
    ...config.transferOption,
    fallbackMode: stat.mode,
    mtime: stat.mtime,
    atime: stat.atime,
    filePerm: config?.filePerm,
    dirPerm: config?.dirPerm,
  };
  await transferWithType(
    { ...config, transferOption, ensureDirExist: true },
    stat.type,
    collect
  );
}

export async function sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void
): Promise<FileEntry[]> {
  const deleted: FileEntry[] = [];
  await _sync(config, collect, deleted);
  return deleted;
}
