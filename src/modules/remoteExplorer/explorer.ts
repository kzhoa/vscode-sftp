import * as vscode from 'vscode';
import { registerCommand, setContextValue } from '../../host';
import {
  COMMAND_REMOTEEXPLORER_REFRESH,
  COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE,
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
} from '../../constants';
import { UResource } from '../../core';
import { toRemotePath } from '../../helper';
import { REMOTE_SCHEME } from '../../constants';
import { getFileService } from '../serviceManager';
import app from '../../app';
import { getStableRootId } from './rootIdRegistry';
import RemoteTreeDataProvider, { ExplorerItem } from './treeDataProvider';
import RemoteExplorerDragAndDropController from './dragAndDropController';
import RemoteExplorerCheckedStore, { type CheckedExplorerItemRef } from './checkedItems';

export default class RemoteExplorer {
  private _explorerView: vscode.TreeView<ExplorerItem>;
  private _treeDataProvider: RemoteTreeDataProvider;
  private _dragAndDropController: RemoteExplorerDragAndDropController;
  private _checkedStore: RemoteExplorerCheckedStore;

  constructor(context: vscode.ExtensionContext) {
    this._checkedStore = new RemoteExplorerCheckedStore();
    this._treeDataProvider = new RemoteTreeDataProvider(this._checkedStore);
    this._dragAndDropController = new RemoteExplorerDragAndDropController(this._treeDataProvider);
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, this._treeDataProvider)
    );

    this._explorerView = vscode.window.createTreeView('remoteExplorer', {
      showCollapseAll: true,
      treeDataProvider: this._treeDataProvider,
      canSelectMany: true,
      dragAndDropController: this._dragAndDropController,
      manageCheckboxStateManually: true,
    });
    context.subscriptions.push(
      this._explorerView.onDidChangeCheckboxState(event => {
        if (!this._checkedStore.applyChanges(event.items)) {
          return;
        }

        this._treeDataProvider.refreshItems(event.items.map(([item]) => item));
        this._syncCheckedUi();
      })
    );

    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH, () => this._refreshSelection());
    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE, () => this._refreshActiveRemoteFile());
    registerCommand(context, COMMAND_REMOTEEXPLORER_VIEW_CONTENT, (item: ExplorerItem) =>
      this._treeDataProvider.showItem(item)
    );
    this._syncCheckedUi();
  }

  markReady() {
    this._treeDataProvider.markReady();
  }

  refresh(item?: ExplorerItem) {
    if (item && !UResource.isRemote(item.resource.uri)) {
      const uri = item.resource.uri;
      const fileService = getFileService(uri);
      if (!fileService) {
        return;
      }
      const config = fileService.getConfig();
      const localPath = item.resource.fsPath;
      const remotePath = toRemotePath(localPath, config.context, config.remotePath);
      const activeProfile = app.configStore.getActiveProfile(fileService.baseDir);
      const remoteId = getStableRootId(fileService.baseDir, activeProfile);
      item.resource = UResource.makeResource({
        remote: {
          host: config.host,
          port: config.port,
        },
        fsPath: remotePath,
        remoteId,
      });
    }

    this._treeDataProvider.refresh(item);
  }

  reveal(item: ExplorerItem): Thenable<void> {
    if (item && UResource.isRemote(item.resource.uri) && !this.findRoot(item.resource.uri)) {
      return Promise.resolve();
    }

    return item ? this._explorerView.reveal(item) : Promise.resolve();
  }

  findRoot(remoteUri: vscode.Uri) {
    return this._treeDataProvider.findRoot(remoteUri);
  }

  getCheckedItems(): ExplorerItem[] {
    const { items, pruned } = this._collectResolvedCheckedItems();
    if (pruned) {
      this._applyCheckedUi(items.length);
    }
    return items;
  }

  hasCheckedItems(): boolean {
    const { items, pruned } = this._collectResolvedCheckedItems();
    if (pruned) {
      this._applyCheckedUi(items.length);
    }
    return items.length > 0;
  }

  clearCheckedItems() {
    const checkedItems = this.getCheckedItems();
    if (!this._checkedStore.clear()) {
      return;
    }

    this._treeDataProvider.refreshItems(checkedItems);
    this._syncCheckedUi();
  }

  downloadToLocalDirectory(targetUri: vscode.Uri, source: readonly ExplorerItem[]) {
    return this._dragAndDropController.downloadToLocalDirectory(targetUri, source);
  }

  private _refreshSelection() {
    const checkedItems = this.getCheckedItems();
    if (checkedItems.length) {
      checkedItems.forEach(item => this.refresh(item));
    } else if (this._explorerView.selection.length) {
      this._explorerView.selection.forEach(item => this.refresh(item));
    } else {
      this.refresh();
    }
  }

  private _refreshActiveRemoteFile() {
    const focusedEditor = vscode.window.activeTextEditor;
    if (focusedEditor) {

      const remoteFileUri = focusedEditor.document.uri;
      const root = this._treeDataProvider.findRoot(remoteFileUri);
      const incompleteResource = UResource.makeResource(remoteFileUri);

      if (!root) {
        return;
      }
      const remoteFileItem = {
        resource: UResource.updateResource(root.resource, {
          remotePath: incompleteResource.fsPath
        }),
        isDirectory: false
      };

      this.refresh(remoteFileItem);
    }
  }

  private _resolveCheckedItem(item: CheckedExplorerItemRef): ExplorerItem | null {
    return this._treeDataProvider.resolveCheckedItem(item);
  }

  private _syncCheckedUi() {
    const { items } = this._collectResolvedCheckedItems();
    this._applyCheckedUi(items.length);
  }

  private _applyCheckedUi(count: number) {
    this._explorerView.badge = count ? { value: count, tooltip: `${count} checked item(s)` } : undefined;
    setContextValue('remoteExplorer.hasCheckedItems', count > 0);
  }

  private _collectResolvedCheckedItems(): { items: ExplorerItem[]; pruned: boolean } {
    const staleKeys: string[] = [];
    const resolvedItems: ExplorerItem[] = [];

    for (const item of this._checkedStore.values()) {
      const resolved = this._resolveCheckedItem(item);
      if (resolved) {
        resolvedItems.push(resolved);
      } else {
        staleKeys.push(item.key);
      }
    }

    return {
      items: resolvedItems,
      pruned: staleKeys.length ? this._checkedStore.deleteKeys(staleKeys) : false,
    };
  }
}
