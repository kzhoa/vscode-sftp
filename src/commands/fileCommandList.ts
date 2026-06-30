import { COMMAND_LIST } from '../constants';
import { showTextDocument } from '../host';
import { FileType } from '../core';
import { downloadFile, downloadFolder } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { selectFile } from './shared';

export default checkFileCommand({
  id: COMMAND_LIST,
  getFileTarget: selectFile,

  async handleFile(ctx) {
    await ctx.fileService.withRemoteFileSystem(ctx.config, async remotefs => {
      const fileEntry = await remotefs.lstat(ctx.target.remoteFsPath);
      if (fileEntry.type !== FileType.Directory) {
        await downloadFile(ctx);
        try {
          await showTextDocument(ctx.target.localUri);
        } catch (_error) {
          // ignore
        }
      } else {
        await downloadFolder(ctx);
      }
    });
  },
});
