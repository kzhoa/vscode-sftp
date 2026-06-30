import { COMMAND_DOWNLOAD_FOLDER } from '../constants';
import { downloadFolder } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { checkedRemoteDirectoryUris, shouldUseCheckedRemoteItems, uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_DOWNLOAD_FOLDER,
  getFileTarget(item, items) {
    if (shouldUseCheckedRemoteItems(item, items)) {
      return checkedRemoteDirectoryUris() ?? uriFromExplorerContextOrEditorContext(item, items);
    }

    return uriFromExplorerContextOrEditorContext(item, items);
  },

  handleFile: downloadFolder,
});
