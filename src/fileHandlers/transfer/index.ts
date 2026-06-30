import { refreshRemoteExplorer } from '../shared';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import { transfer, sync, TransferOption, SyncOption, TransferDirection } from './transfer';
import { resolveSyncOptionForDirection } from '../../core/syncOption';

function createTransferHandle(direction: TransferDirection) {
  return async function handle(this: FileHandlerContext, option) {
    await this.fileService.withRemoteFileSystem(this.config, async remoteFs => {
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
      let transferConfig;

      if (direction === TransferDirection.REMOTE_TO_LOCAL) {
        transferConfig = {
          srcFsPath: remoteFsPath,
          srcFs: remoteFs,
          targetFsPath: localFsPath,
          targetFs: localFs,
          transferOption: option,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        };
      } else {
        transferConfig = {
          srcFsPath: localFsPath,
          srcFs: localFs,
          targetFsPath: remoteFsPath,
          targetFs: remoteFs,
          transferOption: option,
          filePerm: this.config.filePerm,
          dirPerm: this.config.dirPerm,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        };
      }
      await transfer(transferConfig, t => scheduler.add(t));
      await scheduler.run();
    });
  };
}

const uploadHandle = createTransferHandle(TransferDirection.LOCAL_TO_REMOTE);
const downloadHandle = createTransferHandle(TransferDirection.REMOTE_TO_LOCAL);

export const sync2Remote = createFileHandler<SyncOption>({
  name: 'sync local ➞ remote',
  async handle(option) {
    await this.fileService.withRemoteFileSystem(this.config, async remoteFs => {
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
      option.filePerm = this.config.filePerm;
      option.dirPerm = this.config.dirPerm;
      await sync(
        {
          srcFsPath: localFsPath,
          srcFs: localFs,
          targetFsPath: remoteFsPath,
          targetFs: remoteFs,
          transferOption: option,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        },
        t => scheduler.add(t)
      );
      await scheduler.run();
    });
  },
  transformOption() {
    const config = this.config;
    const syncOption = resolveSyncOptionForDirection(
      config.resolvedSyncOption!,
      'toRemote'
    );
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      create: syncOption.create,
      delete: syncOption.delete,
      update: syncOption.update,
      compare: syncOption.compare,
      symbolicLink: syncOption.symbolicLink,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const sync2Local = createFileHandler<SyncOption>({
  name: 'sync remote ➞ local',
  async handle(option) {
    await this.fileService.withRemoteFileSystem(this.config, async remoteFs => {
      const localFs = this.fileService.getLocalFileSystem();
      const { localFsPath, remoteFsPath } = this.target;
      const scheduler = this.fileService.createTransferScheduler(this.config.concurrency);
      await sync(
        {
          srcFsPath: remoteFsPath,
          srcFs: remoteFs,
          targetFsPath: localFsPath,
          targetFs: localFs,
          transferOption: option,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        },
        t => scheduler.add(t)
      );
      await scheduler.run();
    });
  },
  transformOption() {
    const config = this.config;
    const syncOption = resolveSyncOptionForDirection(
      config.resolvedSyncOption!,
      'toLocal'
    );
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
      create: syncOption.create,
      delete: syncOption.delete,
      update: syncOption.update,
      compare: syncOption.compare,
      symbolicLink: syncOption.symbolicLink,
    };
  },
});

export const upload = createFileHandler<TransferOption>({
  name: 'upload',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, this.fileService);
  },
});

export const uploadFile = createFileHandler<TransferOption>({
  name: 'upload file',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const download = createFileHandler<TransferOption>({
  name: 'download',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: false,
      // remoteTimeOffsetInHours: config.remoteTimeOffsetInHours,
      ignore: config.ignore,
    };
  },
});
