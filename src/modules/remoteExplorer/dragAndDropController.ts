import * as vscode from 'vscode';
import { createDataTransferItem } from '../../host';
import { reportError } from '../../helper';
import type RemoteTreeDataProvider from './treeDataProvider';
import type { ExplorerItem, ExplorerRoot } from './treeDataProvider';
import RemoteExplorerDropValidator from './dropValidator';
import RemoteExplorerTransferService from './transferService';
import {
  parseRemoteItems,
  parseUriList,
  REMOTE_EXPLORER_TREE_MIME,
  serializeRemoteDragItems,
  toUriList,
  URI_LIST_MIME,
} from './dragAndDropTypes';

export default class RemoteExplorerDragAndDropController
  implements vscode.TreeDragAndDropController<ExplorerItem> {
  readonly dropMimeTypes = [REMOTE_EXPLORER_TREE_MIME, URI_LIST_MIME];
  readonly dragMimeTypes = [REMOTE_EXPLORER_TREE_MIME, URI_LIST_MIME];

  constructor(
    private readonly treeDataProvider: RemoteTreeDataProvider,
    private readonly validator = new RemoteExplorerDropValidator(),
    private readonly transferService = new RemoteExplorerTransferService()
  ) {}

  handleDrag(source: readonly ExplorerItem[], dataTransfer: vscode.DataTransfer): void {
    const payload = serializeRemoteDragItems(source);
    dataTransfer.set(REMOTE_EXPLORER_TREE_MIME, createDataTransferItem(payload));
    dataTransfer.set(
      URI_LIST_MIME,
      createDataTransferItem(toUriList(source.map(item => item.resource.uri)))
    );
  }

  async handleDrop(target: ExplorerItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    try {
      const targetRoot = this._requireTargetRoot(target);
      const remoteItems = await parseRemoteItems(dataTransfer);
      if (remoteItems.length) {
        const plan = this.validator.validateRemoteMove(target, targetRoot, remoteItems);
        await this.transferService.execute(plan);
        return;
      }

      const uris = await parseUriList(dataTransfer);
      const localUris = uris.filter(uri => uri.scheme === 'file');
      if (!localUris.length) {
        throw new Error('This drop payload is not supported by Remote Explorer.');
      }

      const plan = this.validator.validateUpload(target, targetRoot, localUris);
      await this.transferService.execute(plan);
    } catch (error) {
      reportError(error as Error, 'Remote Explorer drag and drop');
    }
  }

  async downloadToLocalDirectory(targetUri: vscode.Uri, source: readonly ExplorerItem[]): Promise<void> {
    try {
      const localTarget = await this.validator.validateLocalDropTarget(targetUri);
      const plan = this.validator.validateDownload(localTarget, source);
      await this.transferService.execute(plan);
    } catch (error) {
      reportError(error as Error, 'Remote Explorer drag and drop');
    }
  }

  private _requireTargetRoot(target: ExplorerItem | undefined): ExplorerRoot {
    if (!target) {
      throw new Error('Drop onto a remote folder or root.');
    }

    const root = this.treeDataProvider.findRoot(target.resource.uri);
    if (!root || root.explorerContext.invalid) {
      throw new Error('This remote drop target is stale. Refresh Remote Explorer and try again.');
    }
    return root;
  }
}
