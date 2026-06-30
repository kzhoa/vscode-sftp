import { COMMAND_FORCE_DOWNLOAD } from '../constants';
import { download } from '../fileHandlers';
import { checkedRemoteMixedUris, shouldUseCheckedRemoteItems, uriFromExplorerContextOrEditorContext } from './shared';
import { checkFileCommand } from './abstract/createCommand';

export default checkFileCommand({
  id: COMMAND_FORCE_DOWNLOAD,
  getFileTarget(item, items) {
    if (shouldUseCheckedRemoteItems(item, items)) {
      return checkedRemoteMixedUris() ?? uriFromExplorerContextOrEditorContext(item, items);
    }

    return uriFromExplorerContextOrEditorContext(item, items);
  },

  async handleFile(ctx) {
    await download(ctx, { ignore: null });
  },
});
