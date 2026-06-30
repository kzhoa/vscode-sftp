import * as path from 'path';
import * as vscode from 'vscode';
import { FileType, UResource, upath } from '../../core';
import type { ExplorerItem, ExplorerRoot } from './treeDataProvider';

export const REMOTE_EXPLORER_TREE_MIME = 'application/vnd.code.tree.remoteexplorer';
export const URI_LIST_MIME = 'text/uri-list';

export type RemoteDropOperation = 'upload' | 'download' | 'remoteMove';
export type ConflictResolution = 'overwrite' | 'skip' | 'cancel';

export interface RemoteDragItemPayload {
  remoteUri: string;
  remotePath: string;
  isDirectory: boolean;
  remoteId: number;
}

export interface UploadPlanEntry {
  sourceUri: vscode.Uri;
  sourcePath: string;
  targetPath: string;
}

export interface DownloadPlanEntry {
  sourceItem: ExplorerItem;
  sourcePath: string;
  targetPath: string;
}

export interface RemoteMovePlanEntry {
  sourceItem: ExplorerItem;
  sourcePath: string;
  targetPath: string;
}

export interface ConflictEntry {
  operation: RemoteDropOperation;
  sourcePath: string;
  targetPath: string;
  sourceType: FileType;
  targetType: FileType;
}

interface BaseDropValidationResult {
  targetRoot: ExplorerRoot;
  targetDirectory: string;
}

export interface UploadValidationResult extends BaseDropValidationResult {
  operation: 'upload';
  uploads: UploadPlanEntry[];
}

export interface RemoteMoveValidationResult extends BaseDropValidationResult {
  operation: 'remoteMove';
  remoteMoves: RemoteMovePlanEntry[];
}

export type DropValidationResult = UploadValidationResult | RemoteMoveValidationResult;

export function getItemRoot(item: ExplorerItem): ExplorerRoot | null {
  return 'explorerContext' in item ? item : null;
}

export function getRemoteRootId(item: ExplorerItem): number {
  return UResource.makeResource(item.resource.uri).remoteId;
}

export function isRootItem(item: ExplorerItem): item is ExplorerRoot {
  return 'explorerContext' in item;
}

export function getRemoteDirectoryTarget(target: ExplorerItem | undefined): string | null {
  if (!target) {
    return null;
  }
  if (!target.isDirectory) {
    return null;
  }
  return target.resource.fsPath;
}

export function normalizeRemoteDragSources(items: readonly ExplorerItem[]): ExplorerItem[] {
  const seen = new Map<number, string[]>();
  return [...items]
    .sort((a, b) => a.resource.fsPath.length - b.resource.fsPath.length)
    .filter(item => {
      const rootId = getRemoteRootId(item);
      const fsPath = item.resource.fsPath;
      const paths = seen.get(rootId);

      if (paths) {
        if (paths.includes(fsPath)) {
          return false;
        }
        for (const existingPath of paths) {
          if (fsPath !== existingPath && isDescendantPath(existingPath, fsPath, true)) {
            return false;
          }
        }
        paths.push(fsPath);
      } else {
        seen.set(rootId, [fsPath]);
      }

      return true;
    });
}

export function normalizeLocalUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  return [...uris]
    .sort((a, b) => a.fsPath.length - b.fsPath.length)
    .filter(uri => {
      if (uri.scheme !== 'file') {
        return false;
      }
      if (seen.has(uri.fsPath)) {
        return false;
      }
      for (const existing of seen) {
        if (uri.fsPath !== existing && isDescendantPath(existing, uri.fsPath, false)) {
          return false;
        }
      }
      seen.add(uri.fsPath);
      return true;
    });
}

export function serializeRemoteDragItems(items: readonly ExplorerItem[]): RemoteDragItemPayload[] {
  return items.map(item => ({
    remoteUri: item.resource.uri.toString(),
    remotePath: item.resource.fsPath,
    isDirectory: item.isDirectory,
    remoteId: UResource.makeResource(item.resource.uri).remoteId,
  }));
}

export function deserializeRemoteDragItems(payload: readonly RemoteDragItemPayload[]): ExplorerItem[] {
  return payload.map(item => ({
    resource: UResource.makeResource(vscode.Uri.parse(item.remoteUri)),
    isDirectory: item.isDirectory,
  }));
}

export async function parseUriList(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const item = dataTransfer.get(URI_LIST_MIME);
  if (!item) {
    return [];
  }

  const raw = await item.asString();
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => Boolean(line) && !line.startsWith('#'))
    .map(line => vscode.Uri.parse(line));
}

export async function parseRemoteItems(dataTransfer: vscode.DataTransfer): Promise<ExplorerItem[]> {
  const item = dataTransfer.get(REMOTE_EXPLORER_TREE_MIME);
  if (!item) {
    return [];
  }

  const value = item.value;
  if (Array.isArray(value)) {
    return deserializeRemoteDragItems(value as RemoteDragItemPayload[]);
  }

  const raw = await item.asString();
  if (!raw) {
    return [];
  }

  return deserializeRemoteDragItems(JSON.parse(raw) as RemoteDragItemPayload[]);
}

export function toUriList(uris: readonly vscode.Uri[]): string {
  return uris.map(uri => uri.toString()).join('\r\n');
}

export function isDescendantPath(parentPath: string, candidatePath: string, remote: boolean): boolean {
  const resolver = remote ? upath : path;
  const relative = resolver.relative(parentPath, candidatePath);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${resolver.sep}`);
}
