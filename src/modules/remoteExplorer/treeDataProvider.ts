import * as vscode from 'vscode';
import { showTextDocument } from '../../host';
import {
  upath,
  UResource,
  Resource,
  FileService,
  FileType,
  FileEntry,
  Ignore,
  ServiceConfig,
  StaleConfigError,
} from '../../core';
import {
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
  COMMAND_REMOTEEXPLORER_EDITINLOCAL,
} from '../../constants';
import { getAllFileService } from '../serviceManager';
import { getExtensionSetting } from '../ext';

import { getStableRootId } from './rootIdRegistry';
import { createStaleRemoteDocumentError, createStaleRemoteItemError } from './errors';

type Id = number;

const previewDocumentPathPrefix = '/~ ';

const DEFAULT_FILES_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store'];
/**
 * covert the url path for a customed docuemnt title
 *
 *  There is no api to custom title.
 *  So we change url path for custom title.
 *  This is not break anything because we get fspth from uri.query.'
 */
function makePreivewUrl(uri: vscode.Uri) {
  // const query = querystring.parse(uri.query);
  // query.originPath = uri.path;
  // query.originQuery = uri.query;

  return uri.with({
    path: previewDocumentPathPrefix + upath.basename(uri.path),
    // query: querystring.stringify(query),
  });
}

interface ExplorerChild {
  resource: Resource;
  isDirectory: boolean;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    fileService: FileService;
    config: ServiceConfig;
    id: Id;
    profile: string | null;
    invalid?: { error: string };
  };
}

export type ExplorerItem = ExplorerRoot | ExplorerChild;

function dirFirstSort(fileA: ExplorerItem, fileB: ExplorerItem) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resource.fsPath.localeCompare(fileB.resource.fsPath);
  }

  return fileA.isDirectory ? -1 : 1;
}

export default class RemoteTreeData
  implements vscode.TreeDataProvider<ExplorerItem>, vscode.TextDocumentContentProvider {
  private _roots: ExplorerRoot[] | null;
  private _rootsMap: Map<Id, ExplorerRoot> | null;
  private _map: Map<vscode.Uri['query'], ExplorerItem>;
  private _ready: Promise<void>;
  private _resolveReady: () => void;

  constructor() {
    this._ready = new Promise<void>(resolve => {
      this._resolveReady = resolve;
    });
  }

  markReady() {
    this._resolveReady();
  }

  private _onDidChangeFolder: vscode.EventEmitter<ExplorerItem | undefined> = new vscode.EventEmitter<
    ExplorerItem | undefined
  >();
  private _onDidChangeFile: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData: vscode.Event<ExplorerItem | undefined> = this._onDidChangeFolder.event;
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChangeFile.event;

  async refresh(item?: ExplorerItem): Promise<any> {
    // refresh root
    if (!item) {
      this._roots = null;
      this._rootsMap = null;

      this._onDidChangeFolder.fire(undefined);
      return;
    }

    if (UResource.isRemote(item.resource.uri) && !this.findRoot(item.resource.uri)) {
      return;
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);

      // refresh top level files as well
      const children = await this.getChildren(item);
      children
        .filter(i => !i.isDirectory)
        .forEach(i => this._onDidChangeFile.fire(makePreivewUrl(i.resource.uri)));
    } else {
      const parent = await this.getParent(item);
      if (parent) {
        this._onDidChangeFolder.fire(parent);
      }
      this._onDidChangeFile.fire(makePreivewUrl(item.resource.uri));
    }
  }

  private _getRootLabel(root: ExplorerRoot): string {
    const { config, profile, invalid } = root.explorerContext;
    if (invalid) {
      return `! ${profile ?? 'default'}`;
    }
    if (!profile) {
      return root.explorerContext.fileService.name || 'My Server';
    }
    const maxPathLen = 20;
    const remotePath = config.remotePath;
    const truncatedPath = remotePath.length > maxPathLen
      ? '...' + remotePath.slice(-maxPathLen)
      : remotePath;
    return `${profile}@${config.username}[${truncatedPath}]`;
  }

  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    const isRoot = (item as ExplorerRoot).explorerContext !== undefined;
    let customLabel: string | undefined;
    if (isRoot) {
      customLabel = this._getRootLabel(item as ExplorerRoot);
    }
    if (!customLabel) {
      customLabel = upath.basename(item.resource.fsPath);
    }

    if (isRoot && (item as ExplorerRoot).explorerContext.invalid) {
      const { error } = (item as ExplorerRoot).explorerContext.invalid!;
      const treeItem = new vscode.TreeItem(customLabel, vscode.TreeItemCollapsibleState.None);
      treeItem.description = '(invalid)';
      treeItem.tooltip = error;
      treeItem.contextValue = 'invalidRoot';
      treeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.deemphasizedForeground'));
      return treeItem;
    }

    return {
      label: customLabel,
      resourceUri: item.resource.uri,
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: isRoot ? 'root' : item.isDirectory ? 'folder' : 'file',
      command: item.isDirectory
        ? undefined
        : {
            command: getExtensionSetting().downloadWhenOpenInRemoteExplorer
              ? COMMAND_REMOTEEXPLORER_EDITINLOCAL
              : COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
            arguments: [item],
            title: 'View Remote Resource',
          },
    };
  }

  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      await this._ready;
      return this._getRoots();
    }

    const root = this.findRoot(item.resource.uri);
    if (!root) {
      throw createStaleRemoteItemError();
    }
    if (root.explorerContext.invalid) {
      return [];
    }
    const config = root.explorerContext.config;
    try {
      return await root.explorerContext.fileService.withRemoteFileSystem(config, async remotefs => {
        const fileEntries = await remotefs.list(item.resource.fsPath);

        const filesExcludeList: string[] =
          config.remoteExplorer && config.remoteExplorer.filesExclude
            ? config.remoteExplorer.filesExclude.concat(DEFAULT_FILES_EXCLUDE)
            : DEFAULT_FILES_EXCLUDE;

        const ignore = new Ignore(filesExcludeList);
        function filterFile(file: FileEntry) {
          const relativePath = upath.relative(config.remotePath, file.fspath);
          return !ignore.ignores(relativePath);
        }

        return fileEntries
          .filter(filterFile)
          .map(file => {
            const isDirectory = file.type === FileType.Directory;
            const newResource = UResource.updateResource(item.resource, {
              remotePath: file.fspath,
            });
            const mapItem = this._map.get(newResource.uri.query);
            if (mapItem) {
              return mapItem;
            } else {
              const newItem = {
                resource: UResource.updateResource(item.resource, {
                  remotePath: file.fspath,
                }),
                isDirectory,
              };
              this._map.set(newItem.resource.uri.query, newItem);
              return newItem;
            }
          })
          .sort(dirFirstSort);
      });
    } catch (err) {
      if (err instanceof StaleConfigError) {
        return [];
      }
      throw err;
    }
  }

  async getParent(item: ExplorerChild): Promise<ExplorerItem> {
    const resourceUri = item.resource.uri;
    const root = this.findRoot(resourceUri);
    if (!root) {
      throw createStaleRemoteItemError();
    }

    if (item.resource.fsPath === root.resource.fsPath) {
      return root;
    }

    const fspath = upath.dirname(item.resource.fsPath);
    const newResource = UResource.updateResource(item.resource, {
      remotePath: fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    } else {
      const newMapItem = {
        resource: newResource,
        isDirectory: true,
      };
      this._map.set(newResource.uri.query, newMapItem);
      await this.getChildren(newMapItem);
      return newMapItem;
    }
  }

  findRoot(uri: vscode.Uri): ExplorerRoot | null | undefined {
    if (!this._rootsMap) {
      return null;
    }

    const rootId = UResource.makeResource(uri).remoteId;
    return this._rootsMap.get(rootId);
  }


  async provideTextDocumentContent(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<string> {
    const root = this.findRoot(uri);
    if (!root) {
      throw createStaleRemoteDocumentError();
    }

    const config = root.explorerContext.config;
    try {
      return await root.explorerContext.fileService.withRemoteFileSystem(config, async remotefs => {
        const buffer = await remotefs.readFile(UResource.makeResource(uri).fsPath);
        return buffer.toString();
      });
    } catch (err) {
      if (err instanceof StaleConfigError) {
        throw createStaleRemoteDocumentError();
      }
      throw err;
    }
  }

  showItem(item: ExplorerItem): void {
    if (item.isDirectory) {
      return;
    }

    showTextDocument(makePreivewUrl(item.resource.uri));
  }

  private _getRoots(): ExplorerRoot[] {
    if (this._roots) {
      return this._roots;
    }

    this._roots = [];
    this._rootsMap = new Map();
    this._map = new Map();
    getAllFileService().forEach(fileService => {
      const profiles = fileService.getAvailableProfiles();
      const entries: Array<{ profile: string | null; config: ServiceConfig }> =
        profiles.length > 0
          ? profiles.map(p => ({ profile: p, config: fileService.getConfig(p) }))
          : [{ profile: null, config: fileService.getConfig(null) }];

      for (const { profile, config } of entries) {
        const rootId = getStableRootId(fileService.baseDir, profile);
        const item: ExplorerRoot = {
          resource: UResource.makeResource({
            remote: {
              host: config.host,
              port: config.port,
            },
            fsPath: config.remotePath,
            remoteId: rootId,
          }),
          isDirectory: true,
          explorerContext: {
            fileService,
            config,
            id: rootId,
            profile,
          },
        };
        this._roots!.push(item);
        this._rootsMap!.set(rootId, item);
        this._map.set(item.resource.uri.query, item);
      }

      const invalidProfiles = fileService.getInvalidProfiles();
      for (const { name, error } of invalidProfiles) {
        const rootId = getStableRootId(fileService.baseDir, name);
        const placeholderConfig = {} as ServiceConfig;
        const item: ExplorerRoot = {
          resource: UResource.makeResource({
            remote: { host: 'invalid', port: 0 },
            fsPath: '/',
            remoteId: rootId,
          }),
          isDirectory: false,
          explorerContext: {
            fileService,
            config: placeholderConfig,
            id: rootId,
            profile: name,
            invalid: { error },
          },
        };
        this._roots!.push(item);
        this._rootsMap!.set(rootId, item);
      }
    });
    this._roots.sort((a, b) => {
      const aInvalid = a.explorerContext.invalid ? 1 : 0;
      const bInvalid = b.explorerContext.invalid ? 1 : 0;
      if (aInvalid !== bInvalid) return aInvalid - bInvalid;
      if (!a.explorerContext.invalid && !b.explorerContext.invalid) {
        const orderDiff = a.explorerContext.config.remoteExplorer.order - b.explorerContext.config.remoteExplorer.order;
        if (orderDiff !== 0) return orderDiff;
      }
      return this._getRootLabel(a).localeCompare(this._getRootLabel(b));
    });
    return this._roots;
  }
}
