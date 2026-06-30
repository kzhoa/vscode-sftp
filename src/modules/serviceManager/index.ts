import { Uri } from 'vscode';
import * as path from 'path';
import app from '../../app';
import logger from '../../logger';
import { simplifyPath, reportError } from '../../helper';
import { UResource, FileService, TransferTask } from '../../core';
import type { ConfigEntry, ConfigId } from '../../core';
import watcherService from '../fileWatcher';
import { resolveRootEntry } from '../remoteExplorer/rootIdRegistry';
import Trie from './trie';

const WIN_DRIVE_REGEX = /^([a-zA-Z]):/;
const isWindows = process.platform === 'win32';

const serviceManager = new Trie<FileService>(
  {},
  {
    delimiter: path.sep,
  }
);
const pendingRuntimeReloadIds = new Set<ConfigId>();
let runtimeReloadScheduled = false;

function maskConfig(config) {
  const copy = {};
  const MASK = '******';
  Object.keys(config).forEach(key => {
    const configValue = config[key];
    switch (key) {
      case 'username':
      case 'password':
      case 'passphrase':
        copy[key] = MASK;
        break;
      case 'interactiveAuth':
        if (Array.isArray(configValue)) {
          copy[key] = configValue.map(_phrase => MASK);
        } else {
          copy[key] = configValue;
        }
        break;
      default:
        copy[key] = configValue;
    }
  });
  return copy;
}

function normalizePathForTrie(pathname) {
  if (isWindows) {
    const device = pathname.substr(0, 2);
    if (device.charAt(1) === ':') {
      // lowercase drive letter
      pathname = pathname[0].toLowerCase() + pathname.substr(1);
    }
  }

  return path.normalize(pathname);
}

export function getBasePath(context: string, workspace: string) {
  let dirpath;
  if (context) {
    if (path.isAbsolute(context)) {
      dirpath = context;
      if (isWindows) {
        const contextBeginWithDrive = context.match(WIN_DRIVE_REGEX);
        // if a windows user omit drive, we complete it with a drive letter same with the workspace one
        if (!contextBeginWithDrive) {
          const workspaceDrive = workspace.match(WIN_DRIVE_REGEX);
          if (workspaceDrive) {
            const drive = workspaceDrive[1];
            dirpath = path.join(`${drive}:`, context);
          }
        }
      }
    } else {
      // Don't use path.resolve bacause it may change the root dir of workspace!
      // Example: On window path.resove('\\a\\b\\c') will result to '<drive>:\\a\\b\\c'
      // We know workspace must be a absolute path and context is a relative path to workspace,
      // so path.join will suit our requirements.
      dirpath = path.join(workspace, context);
    }
  } else {
    dirpath = workspace;
  }

  return normalizePathForTrie(dirpath);
}

function attachTransferHooks(service: FileService): void {
  service.setWatcherService(watcherService);
  service.beforeTransfer(task => {
    const { localFsPath, transferType } = task;
    app.sftpBarItem.showMsg(
      `${transferType} ${path.basename(localFsPath)}`,
      simplifyPath(localFsPath)
    );
  });
  service.afterTransfer((error, task) => {
    const { localFsPath, transferType } = task;
    const filename = path.basename(localFsPath);
    const filepath = simplifyPath(localFsPath);
    if (task.isCancelled()) {
      logger.info(`cancel transfer ${localFsPath}`);
      app.sftpBarItem.showMsg(`cancelled ${filename}`, filepath, 2000 * 2);
    } else if (error) {
      reportError(error, `when ${transferType} ${localFsPath}`);
      app.sftpBarItem.showMsg(`failed ${filename}`, filepath, 2000 * 2);
    } else {
      logger.info(`${transferType} ${localFsPath}`);
      app.sftpBarItem.showMsg(`done ${filename}`, filepath, 2000 * 2);
    }
  });
}

export function getFileService(uri: Uri): FileService {
  let fileService;
  if (UResource.isRemote(uri)) {
    const remoteId = UResource.makeResource(uri).remoteId;
    const rootEntry = resolveRootEntry(remoteId);
    if (rootEntry) {
      const service = serviceManager.findPrefix(rootEntry.baseDir);
      if (service && service.baseDir === rootEntry.baseDir) {
        fileService = service;
      }
    }
  } else {
    fileService = serviceManager.findPrefix(normalizePathForTrie(uri.fsPath));
  }

  return fileService;
}

export function disposeFileService(fileService: FileService) {
  serviceManager.remove(fileService.baseDir);
  void fileService.dispose();
}

export function findAllFileService(predictor: (x: FileService) => boolean): FileService[] {
  if (serviceManager === undefined) {
    return [];
  }

  return getAllFileService().filter(predictor);
}

export function getAllFileService(): FileService[] {
  if (serviceManager === undefined) {
    return [];
  }

  return serviceManager.getAllValues();
}

export function getRunningTransformTasks(): TransferTask[] {
  return getAllFileService().reduce<TransferTask[]>((acc, fileService) => {
    return acc.concat(fileService.getPendingTransferTasks());
  }, []);
}

function onConfigAdded(entry: ConfigEntry) {
  const existing = serviceManager.findPrefix(entry.id);
  if (existing && existing.baseDir === entry.id) {
    return;
  }

  const service = new FileService(entry.id, entry.workspace, app.configStore);
  logger.info(`config added at ${entry.id}`, maskConfig(entry.rawConfig));
  serviceManager.add(entry.id, service);
  attachTransferHooks(service);
}

function onConfigRemoved(id: ConfigId) {
  const service = serviceManager.findPrefix(id);
  if (service && service.baseDir === id) {
    serviceManager.remove(id);
    void service.dispose();
    logger.info(`config removed at ${id}`);
  }
}

function onConfigChanged(ids: ConfigId[]) {
  scheduleRuntimeReload(ids);
}

function onActiveProfileChanged(ids: ConfigId[]) {
  scheduleRuntimeReload(ids);
}

function scheduleRuntimeReload(ids: ConfigId[]) {
  ids.forEach(id => pendingRuntimeReloadIds.add(id));
  if (runtimeReloadScheduled) {
    return;
  }

  runtimeReloadScheduled = true;
  queueMicrotask(() => {
    runtimeReloadScheduled = false;
    const nextIds = Array.from(pendingRuntimeReloadIds);
    pendingRuntimeReloadIds.clear();

    for (const id of nextIds) {
      const service = serviceManager.findPrefix(id);
      if (service && service.baseDir === id) {
        void service.reloadConfig();
        logger.info(`config changed at ${id}`);
      }
    }
  });
}

export function initConfigStoreListeners(): void {
  app.configStore.onAdded(onConfigAdded);
  app.configStore.onRemoved(onConfigRemoved);
  app.configStore.onChanged(onConfigChanged);
  app.configStore.onActiveProfileChanged(onActiveProfileChanged);
}

export function disposeAllFileServices(): void {
  getAllFileService().forEach(disposeFileService);
}
