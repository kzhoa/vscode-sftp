import { showWarningMessage } from '../../host';
import type { ConflictEntry, ConflictResolution, RemoteDropOperation } from './dragAndDropTypes';

const OVERWRITE_ALL = 'Overwrite All';
const SKIP_CONFLICTS = 'Skip Conflicts';
const CANCEL = 'Cancel';

export default class RemoteExplorerConflictResolver {
  async resolve(
    operation: RemoteDropOperation,
    conflicts: readonly ConflictEntry[]
  ): Promise<ConflictResolution> {
    if (!conflicts.length) {
      return 'overwrite';
    }

    const preview = conflicts
      .slice(0, 5)
      .map(conflict => conflict.targetPath)
      .join(', ');
    const suffix = conflicts.length > 5 ? ', ...' : '';
    const message = `Found ${conflicts.length} existing target${conflicts.length > 1 ? 's' : ''} before ${operation}: ${preview}${suffix}`;
    const result = await showWarningMessage(message, OVERWRITE_ALL, SKIP_CONFLICTS, CANCEL);

    switch (result) {
      case OVERWRITE_ALL:
        return 'overwrite';
      case SKIP_CONFLICTS:
        return 'skip';
      default:
        return 'cancel';
    }
  }
}
