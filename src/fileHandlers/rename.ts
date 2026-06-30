import { fileOperations } from '../core';
import createFileHandler from './createFileHandler';

export const renameRemote = createFileHandler<{ originPath: string }>({
  name: 'rename',
  async handle({ originPath }) {
    await this.fileService.withRemoteFileSystem(this.config, async remoteFs => {
      const { localFsPath } = this.target;
      await fileOperations.rename(originPath, localFsPath, remoteFs);
    });
  },
});
