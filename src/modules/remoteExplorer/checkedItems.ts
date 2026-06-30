import * as vscode from 'vscode';
import { UResource, upath } from '../../core';
import type { ExplorerItem, ExplorerRoot } from './treeDataProvider';

export interface CheckedExplorerItemRef {
  key: string;
  remoteId: number;
  remotePath: string;
  isDirectory: boolean;
}

export function getExplorerItemKey(item: ExplorerItem): string {
  const resource = UResource.makeResource(item.resource.uri);
  return getCheckedExplorerItemKey(resource.remoteId, item.resource.fsPath, item.isDirectory);
}

export function getCheckedExplorerItemKey(remoteId: number, remotePath: string, isDirectory: boolean): string {
  return `${remoteId}:${isDirectory ? 'dir' : 'file'}:${remotePath}`;
}

export function createCheckedExplorerItemRef(item: ExplorerItem): CheckedExplorerItemRef {
  const resource = UResource.makeResource(item.resource.uri);
  return {
    key: getExplorerItemKey(item),
    remoteId: resource.remoteId,
    remotePath: item.resource.fsPath,
    isDirectory: item.isDirectory,
  };
}

export function isRootItem(item: ExplorerItem): item is ExplorerRoot {
  return 'explorerContext' in item;
}

export function normalizeCheckedExplorerItems<T extends CheckedExplorerItemRef>(items: readonly T[]): T[] {
  const seen = new Map<number, string[]>();
  return [...items]
    .sort((a, b) => a.remotePath.length - b.remotePath.length)
    .filter(item => {
      const paths = seen.get(item.remoteId);

      if (!paths) {
        seen.set(item.remoteId, [item.remotePath]);
        return true;
      }

      if (paths.includes(item.remotePath)) {
        return false;
      }

      for (const existingPath of paths) {
        if (item.remotePath !== existingPath && isDescendantPath(existingPath, item.remotePath)) {
          return false;
        }
      }

      paths.push(item.remotePath);
      return true;
    });
}

function isDescendantPath(parentPath: string, candidatePath: string): boolean {
  const relative = upath.relative(parentPath, candidatePath);
  return Boolean(relative) && relative !== '.' && relative !== '..' && !relative.startsWith(`..${upath.sep}`);
}

export default class RemoteExplorerCheckedStore {
  private readonly items = new Map<string, CheckedExplorerItemRef>();

  get size(): number {
    return this.items.size;
  }

  hasCheckedItems(): boolean {
    return this.items.size > 0;
  }

  isChecked(item: ExplorerItem): boolean {
    return this.items.has(getExplorerItemKey(item));
  }

  setChecked(item: ExplorerItem, checked: boolean): boolean {
    const ref = createCheckedExplorerItemRef(item);
    if (checked) {
      const before = this.items.size;
      this.items.set(ref.key, ref);
      return this.items.size !== before;
    }

    return this.items.delete(ref.key);
  }

  applyChanges(items: ReadonlyArray<[ExplorerItem, vscode.TreeItemCheckboxState]>): boolean {
    let changed = false;
    for (const [item, checkboxState] of items) {
      changed = this.setChecked(item, checkboxState === vscode.TreeItemCheckboxState.Checked) || changed;
    }
    return changed;
  }

  clear(): boolean {
    if (!this.items.size) {
      return false;
    }
    this.items.clear();
    return true;
  }

  deleteKeys(keys: readonly string[]): boolean {
    let changed = false;
    for (const key of keys) {
      changed = this.items.delete(key) || changed;
    }
    return changed;
  }

  values(): CheckedExplorerItemRef[] {
    return [...this.items.values()];
  }
}
