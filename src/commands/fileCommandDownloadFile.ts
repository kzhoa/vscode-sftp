import { COMMAND_DOWNLOAD_FILE } from '../constants';
import { downloadFile } from '../fileHandlers';
import { checkedRemoteFileUris, shouldUseCheckedRemoteItems, uriFromExplorerContextOrEditorContext } from './shared';
import { checkFileCommand } from './abstract/createCommand';

export default checkFileCommand({
  id: COMMAND_DOWNLOAD_FILE,
  getFileTarget(item, items) {
    if (shouldUseCheckedRemoteItems(item, items)) {
      return checkedRemoteFileUris() ?? uriFromExplorerContextOrEditorContext(item, items);
    }

    return uriFromExplorerContextOrEditorContext(item, items);
  },

  async handleFile(ctx) {
    await downloadFile(ctx, { ignore: null });
  },
});
