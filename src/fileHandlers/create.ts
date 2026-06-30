import { refreshRemoteExplorer } from './shared';
import { fileOperations } from '../core';
import createFileHandler from './createFileHandler';
import { FileHandleOption } from './option';

export const createRemoteFile = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'createRemoteFile',
  async handle(_option) {
    await this.fileService.withRemoteFileSystem(this.config, async remoteFs => {
      const { remoteFsPath } = this.target;

      let promise;
      promise = fileOperations.createFile(remoteFsPath, remoteFs, {});

      await promise;
    });
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const createRemoteFolder = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'createRemoteFolder',
  async handle(_option) {
    await this.fileService.withRemoteFileSystem(this.config, async remoteFs => {
      const { remoteFsPath } = this.target;

      let promise;
      promise = fileOperations.createDir(remoteFsPath, remoteFs, {});

      await promise;
    });
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});
