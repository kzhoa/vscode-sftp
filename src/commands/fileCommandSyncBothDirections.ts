// DEPRECATED: This command is incompatible with the new directional SyncOption syntax.
// To re-enable bidirectional sync, redesign the SyncOption resolution so that
// remote→local transfers use the toLocal strategy instead of inheriting the
// already-resolved toRemote option.

import { COMMAND_SYNC_BOTH_DIRECTIONS } from '../constants';
import { sync2Remote } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { selectFolderFallbackToConfigContext, uriFromfspath, applySelector } from './shared';

export default checkFileCommand({
  id: COMMAND_SYNC_BOTH_DIRECTIONS,
  getFileTarget: applySelector(uriFromfspath, selectFolderFallbackToConfigContext),

  handleFile(ctx) {
    return sync2Remote(ctx, { bothDiretions: true });
  },
});
