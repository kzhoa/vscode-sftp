import * as path from 'path';
import * as vscode from 'vscode';
import { upath } from '../../core';
import { createStaleRemoteItemError } from './errors';
import type { ExplorerItem, ExplorerRoot } from './treeDataProvider';
import {
  type DownloadPlanEntry,
  type DropValidationResult,
  type RemoteMovePlanEntry,
  type UploadPlanEntry,
  getRemoteDirectoryTarget,
  getRemoteRootId,
  isDescendantPath,
  normalizeLocalUris,
  normalizeRemoteDragSources,
} from './dragAndDropTypes';

export interface DownloadDropTarget {
  uri: vscode.Uri;
  isDirectory: boolean;
}

export default class RemoteExplorerDropValidator {
  validateUpload(
    target: ExplorerItem | undefined,
    targetRoot: ExplorerRoot,
    localUris: readonly vscode.Uri[]
  ): DropValidationResult {
    const targetDirectory = this._requireRemoteDirectory(
      target,
      targetRoot,
      'Drop local files onto a remote folder or root.'
    );
    const uploads = normalizeLocalUris(localUris).map<UploadPlanEntry>(uri => ({
      sourceUri: uri,
      sourcePath: uri.fsPath,
      targetPath: upath.join(targetDirectory, path.basename(uri.fsPath)),
    }));

    if (!uploads.length) {
      throw new Error('No local files were found in this drop payload.');
    }

    return {
      operation: 'upload',
      targetRoot,
      targetDirectory,
      uploads,
    };
  }

  validateRemoteMove(
    target: ExplorerItem | undefined,
    targetRoot: ExplorerRoot,
    sourceItems: readonly ExplorerItem[]
  ): DropValidationResult {
    const targetDirectory = this._requireRemoteDirectory(
      target,
      targetRoot,
      'Drop remote items onto a remote folder or root.'
    );
    const items = normalizeRemoteDragSources(sourceItems);

    if (!items.length) {
      throw new Error('No remote items were found in this drop payload.');
    }

    const moves = items.map<RemoteMovePlanEntry>(item => {
      const sourceRootId = getRemoteRootId(item);
      if (sourceRootId !== targetRoot.explorerContext.id) {
        throw new Error('Remote drag and drop only supports moves within the same root and profile.');
      }
      if (item.resource.fsPath === targetDirectory) {
        throw new Error('Cannot drop a remote item onto itself.');
      }
      const targetPath = upath.join(targetDirectory, upath.basename(item.resource.fsPath));
      if (item.resource.fsPath === targetPath) {
        throw new Error('The selected remote item is already in this folder.');
      }
      if (item.isDirectory && isDescendantPath(item.resource.fsPath, targetDirectory, true)) {
        throw new Error('Cannot move a remote folder into itself or one of its descendants.');
      }

      return {
        sourceItem: item,
        sourcePath: item.resource.fsPath,
        targetPath,
      };
    });

    return {
      operation: 'remoteMove',
      targetRoot,
      targetDirectory,
      remoteMoves: moves,
    };
  }

  validateDownload(target: DownloadDropTarget, sourceItems: readonly ExplorerItem[]): {
    operation: 'download';
    targetUri: vscode.Uri;
    downloads: DownloadPlanEntry[];
  } {
    if (target.uri.scheme !== 'file') {
      throw new Error('Remote downloads only support local file system targets.');
    }
    if (!target.isDirectory) {
      throw new Error('Drop remote items onto a local folder. File targets are not supported.');
    }

    const items = normalizeRemoteDragSources(sourceItems);
    if (!items.length) {
      throw new Error('No remote items were found in this drop payload.');
    }

    return {
      operation: 'download',
      targetUri: target.uri,
      downloads: items.map(item => ({
        sourceItem: item,
        sourcePath: item.resource.fsPath,
        targetPath: path.join(target.uri.fsPath, path.basename(item.resource.fsPath)),
      })),
    };
  }

  async validateLocalDropTarget(uri: vscode.Uri): Promise<DownloadDropTarget> {
    if (uri.scheme !== 'file') {
      throw new Error('Remote downloads only support local file system targets.');
    }

    const stat = await vscode.workspace.fs.stat(uri);
    const isDirectory = Boolean(stat.type & vscode.FileType.Directory);
    return { uri, isDirectory };
  }

  private _requireRemoteDirectory(
    target: ExplorerItem | undefined,
    targetRoot: ExplorerRoot,
    message: string
  ): string {
    const targetDirectory = getRemoteDirectoryTarget(target);
    if (!targetDirectory || !target) {
      throw new Error(message);
    }
    if (getRemoteRootId(target) !== targetRoot.explorerContext.id) {
      throw createStaleRemoteItemError();
    }
    return targetDirectory;
  }
}
