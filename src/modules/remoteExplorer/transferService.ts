import * as path from 'path';
import { refreshExplorer } from '../../host';
import app from '../../app';
import Scheduler from '../../core/scheduler';
import { transfer, type TransferOption, TransferDirection } from '../../fileHandlers/transfer/transfer';
import { FileSystem, FileType, UResource, upath } from '../../core';
import { reportError } from '../../helper';
import RemoteExplorerConflictResolver from './conflictResolver';
import type { ExplorerItem, ExplorerRoot } from './treeDataProvider';
import type {
  ConflictEntry,
  ConflictResolution,
  DownloadPlanEntry,
  DropValidationResult,
  UploadPlanEntry,
} from './dragAndDropTypes';
import { isDescendantPath } from './dragAndDropTypes';

interface LocalDownloadPlan {
  operation: 'download';
  targetUri: { fsPath: string };
  downloads: DownloadPlanEntry[];
}

type ExecutionPlan = DropValidationResult | LocalDownloadPlan;

interface FileSystemLike {
  createTransferScheduler(concurrency: number): {
    add(task: any): void;
    run(): Promise<void>;
  };
  getLocalFileSystem(): FileSystem;
  withRemoteFileSystem<T>(config: any, action: (remoteFs: FileSystem) => Promise<T>): Promise<T>;
}

const DEFAULT_CONFLICT_SCAN_CONCURRENCY = 4;
const MAX_CONFLICT_SCAN_CONCURRENCY = 8;

export default class RemoteExplorerTransferService {
  constructor(private readonly conflictResolver = new RemoteExplorerConflictResolver()) {}

  async execute(plan: ExecutionPlan): Promise<void> {
    const activity = app.sftpBarItem.createActivity(`remote-explorer-dnd-${Date.now()}`, {
      priority: 80,
      spinning: true,
      text: this._activityText(plan.operation, 'Preparing drop...'),
      tooltip: this._describePlan(plan),
    });

    try {
      if (plan.operation === 'upload') {
        await this._executeUpload(plan, activity);
      } else if (plan.operation === 'remoteMove') {
        await this._executeRemoteMove(plan, activity);
      } else {
        await this._executeDownload(plan as LocalDownloadPlan, activity);
      }
    } catch (error) {
      reportError(error as Error, 'Remote Explorer drag and drop');
      throw error;
    } finally {
      activity.dispose();
    }
  }

  async collectConflicts(plan: ExecutionPlan): Promise<ConflictEntry[]> {
    if (plan.operation === 'upload') {
      return this._collectUploadConflicts(plan);
    }
    if (plan.operation === 'remoteMove') {
      return this._collectRemoteMoveConflicts(plan);
    }
    return this._collectDownloadConflicts(plan as LocalDownloadPlan);
  }

  private async _executeUpload(
    plan: Extract<ExecutionPlan, { operation: 'upload' }>,
    activity: { update(update: any): void }
  ) {
    const { fileService, config } = plan.targetRoot.explorerContext;
    const fsService = this._fileService(fileService);
    const conflicts = await this.collectConflicts(plan);
    const decision = await this._resolveConflicts(plan.operation, conflicts);
    if (decision === 'cancel') {
      return;
    }

    activity.update({ text: this._activityText(plan.operation, 'Uploading...') });
    await fsService.withRemoteFileSystem(config, async remoteFs => {
      const localFs = fsService.getLocalFileSystem();
      if (decision === 'overwrite') {
        await this._applyOverwriteConflicts(remoteFs, conflicts);
      }
      for (const entry of plan.uploads ?? []) {
        const ignore = this._createIgnoreFn(decision, conflicts, entry.sourcePath, false);
        await this._runTransfer(fsService, config.concurrency, {
          srcFsPath: entry.sourcePath,
          srcFs: localFs,
          targetFsPath: entry.targetPath,
          targetFs: remoteFs,
          transferOption: {
            perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
            useTempFile: config.useTempFile,
            openSsh: config.openSsh,
            ignore: this._chainIgnore(config.ignore, ignore),
          } satisfies TransferOption,
          filePerm: config.filePerm,
          dirPerm: config.dirPerm,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        });
      }
    });

    this._refreshRemoteDirectory(plan.targetRoot, plan.targetDirectory);
    await refreshExplorer();
  }

  private async _executeDownload(
    plan: LocalDownloadPlan,
    activity: { update(update: any): void }
  ) {
    const root = this._requireSingleRoot(plan.downloads.map(entry => entry.sourceItem));
    const { fileService, config } = root.explorerContext;
    const fsService = this._fileService(fileService);
    const conflicts = await this.collectConflicts(plan);
    const decision = await this._resolveConflicts(plan.operation, conflicts);
    if (decision === 'cancel') {
      return;
    }

    activity.update({ text: this._activityText(plan.operation, 'Downloading...') });
    await fsService.withRemoteFileSystem(config, async remoteFs => {
      const localFs = fsService.getLocalFileSystem();
      if (decision === 'overwrite') {
        await this._applyOverwriteConflicts(localFs, conflicts);
      }
      for (const entry of plan.downloads) {
        const ignore = this._createIgnoreFn(decision, conflicts, entry.sourcePath, true);
        await this._runTransfer(fsService, config.concurrency, {
          srcFsPath: entry.sourcePath,
          srcFs: remoteFs,
          targetFsPath: entry.targetPath,
          targetFs: localFs,
          transferOption: {
            perserveTargetMode: false,
            ignore,
          } satisfies TransferOption,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        });
      }
    });

    await refreshExplorer();
  }

  private async _executeRemoteMove(
    plan: Extract<ExecutionPlan, { operation: 'remoteMove' }>,
    activity: { update(update: any): void }
  ) {
    const { fileService, config } = plan.targetRoot.explorerContext;
    const fsService = this._fileService(fileService);
    const conflicts = await this.collectConflicts(plan);
    const decision = await this._resolveConflicts(plan.operation, conflicts);
    if (decision === 'cancel') {
      return;
    }

    activity.update({ text: this._activityText(plan.operation, 'Moving...') });
    await fsService.withRemoteFileSystem(config, async remoteFs => {
      for (const entry of plan.remoteMoves ?? []) {
        const conflict = conflicts.find(item => item.sourcePath === entry.sourcePath);
        if (conflict && decision === 'skip') {
          continue;
        }
        if (conflict && decision === 'overwrite') {
          await this._removeExistingTarget(remoteFs, conflict.targetPath, conflict.targetType);
        }
        await remoteFs.ensureDir(upath.dirname(entry.targetPath));
        await remoteFs.rename(entry.sourcePath, entry.targetPath);
      }
    });

    const refreshPaths = new Set<string>([plan.targetDirectory]);
    for (const entry of plan.remoteMoves ?? []) {
      refreshPaths.add(upath.dirname(entry.sourcePath));
      refreshPaths.add(upath.dirname(entry.targetPath));
    }
    refreshPaths.forEach(refreshPath => this._refreshRemoteDirectory(plan.targetRoot, refreshPath));
  }

  private async _collectUploadConflicts(
    plan: Extract<ExecutionPlan, { operation: 'upload' }>
  ): Promise<ConflictEntry[]> {
    const { fileService, config } = plan.targetRoot.explorerContext;
    const fsService = this._fileService(fileService);
    return fsService.withRemoteFileSystem(config, async remoteFs => {
      const localFs = fsService.getLocalFileSystem();
      return this._collectTransferConflicts(
        plan.uploads ?? [],
        localFs,
        remoteFs,
        this._conflictScanConcurrency(config.concurrency)
      );
    });
  }

  private async _collectDownloadConflicts(plan: LocalDownloadPlan): Promise<ConflictEntry[]> {
    const root = this._requireSingleRoot(plan.downloads.map(entry => entry.sourceItem));
    const { fileService, config } = root.explorerContext;
    const fsService = this._fileService(fileService);
    return fsService.withRemoteFileSystem(config, async remoteFs => {
      const localFs = fsService.getLocalFileSystem();
      return this._collectTransferConflicts(
        plan.downloads,
        remoteFs,
        localFs,
        this._conflictScanConcurrency(config.concurrency)
      );
    });
  }

  private async _collectRemoteMoveConflicts(
    plan: Extract<ExecutionPlan, { operation: 'remoteMove' }>
  ): Promise<ConflictEntry[]> {
    const { fileService, config } = plan.targetRoot.explorerContext;
    const fsService = this._fileService(fileService);
    return fsService.withRemoteFileSystem(config, async remoteFs => {
      const conflicts: ConflictEntry[] = [];
      for (const entry of plan.remoteMoves ?? []) {
        const targetStat = await this._safeLstat(remoteFs, entry.targetPath);
        if (!targetStat) {
          continue;
        }
        conflicts.push({
          operation: 'remoteMove',
          sourcePath: entry.sourcePath,
          targetPath: entry.targetPath,
          sourceType: entry.sourceItem.isDirectory ? FileType.Directory : FileType.File,
          targetType: targetStat.type,
        });
      }
      return conflicts;
    });
  }

  private async _collectTransferConflicts<T extends UploadPlanEntry | DownloadPlanEntry>(
    entries: readonly T[],
    srcFs: FileSystem,
    targetFs: FileSystem,
    concurrency: number
  ): Promise<ConflictEntry[]> {
    const conflicts: ConflictEntry[] = [];
    const scheduler = new Scheduler({ concurrency, failFast: true });

    const walk = (sourcePath: string, targetPath: string, entry: T) => {
      scheduler.add(async () => {
        const sourceStat = await srcFs.lstat(sourcePath);
        const targetStat = await this._safeLstat(targetFs, targetPath);

        if (sourceStat.type === FileType.Directory) {
          if (targetStat && targetStat.type !== FileType.Directory) {
            conflicts.push({
              operation: 'sourceUri' in entry ? 'upload' : 'download',
              sourcePath,
              targetPath,
              sourceType: sourceStat.type,
              targetType: targetStat.type,
            });
            return;
          }
          const children = await srcFs.list(sourcePath);
          for (const child of children) {
            walk(child.fspath, (targetFs.pathResolver ?? path).join(targetPath, child.name), entry);
          }
          return;
        }

        if (targetStat) {
          conflicts.push({
            operation: 'sourceUri' in entry ? 'upload' : 'download',
            sourcePath,
            targetPath,
            sourceType: sourceStat.type,
            targetType: targetStat.type,
          });
        }
      });
    };

    for (const entry of entries) {
      walk(entry.sourcePath, entry.targetPath, entry);
    }
    await scheduler.drain();
    return conflicts;
  }

  private async _runTransfer(fileService: FileSystemLike, concurrency: number, config: any) {
    const scheduler = fileService.createTransferScheduler(concurrency);
    await transfer(config, task => scheduler.add(task));
    await scheduler.run();
  }

  private async _safeLstat(fs: FileSystem, targetPath: string) {
    try {
      return await fs.lstat(targetPath);
    } catch {
      return null;
    }
  }

  private async _removeExistingTarget(fs: FileSystem, targetPath: string, fileType: FileType) {
    if (fileType === FileType.Directory) {
      await fs.rmdir(targetPath, true);
      return;
    }
    await fs.unlink(targetPath);
  }

  private async _applyOverwriteConflicts(fs: FileSystem, conflicts: readonly ConflictEntry[]) {
    const dedup = new Map<string, ConflictEntry>();
    conflicts.forEach(conflict => dedup.set(conflict.targetPath, conflict));
    for (const conflict of dedup.values()) {
      await this._removeExistingTarget(fs, conflict.targetPath, conflict.targetType);
    }
  }

  private _createIgnoreFn(
    resolution: ConflictResolution,
    conflicts: readonly ConflictEntry[],
    sourceRootPath: string,
    remote: boolean
  ) {
    if (resolution !== 'skip') {
      return undefined;
    }

    const skipped = conflicts
      .filter(conflict =>
        conflict.sourcePath === sourceRootPath
        || isDescendantPath(sourceRootPath, conflict.sourcePath, remote)
      )
      .map(conflict => conflict.sourcePath);
    if (!skipped.length) {
      return undefined;
    }

    return (fsPath: string) => skipped.some(conflictPath => conflictPath === fsPath);
  }

  private _chainIgnore(base: ((fsPath: string) => boolean) | null | undefined, extra?: (fsPath: string) => boolean) {
    if (!base) {
      return extra;
    }
    if (!extra) {
      return base;
    }
    return (fsPath: string) => base(fsPath) || extra(fsPath);
  }

  private async _resolveConflicts(operation: 'upload' | 'download' | 'remoteMove', conflicts: ConflictEntry[]) {
    return this.conflictResolver.resolve(operation, conflicts);
  }

  private _fileService(fileService: unknown): FileSystemLike {
    return fileService as FileSystemLike;
  }

  private _conflictScanConcurrency(concurrency: unknown): number {
    if (typeof concurrency !== 'number' || !Number.isFinite(concurrency) || concurrency < 1) {
      return DEFAULT_CONFLICT_SCAN_CONCURRENCY;
    }

    return Math.max(1, Math.min(Math.trunc(concurrency), MAX_CONFLICT_SCAN_CONCURRENCY));
  }

  private _refreshRemoteDirectory(root: ExplorerRoot, remotePath: string) {
    app.remoteExplorer?.refresh({
      resource: UResource.updateResource(root.resource, { remotePath }),
      isDirectory: true,
    });
  }

  private _activityText(operation: 'upload' | 'download' | 'remoteMove', message: string) {
    const prefix = operation === 'remoteMove'
      ? 'Remote move'
      : operation === 'upload'
        ? 'Remote upload'
        : 'Remote download';
    return `${prefix}: ${message}`;
  }

  private _describePlan(plan: ExecutionPlan) {
    if (plan.operation === 'upload') {
      return `Upload to ${plan.targetDirectory}`;
    }
    if (plan.operation === 'remoteMove') {
      return `Move inside ${plan.targetDirectory}`;
    }
    return `Download to ${plan.targetUri.fsPath}`;
  }

  private _requireSingleRoot(items: readonly ExplorerItem[]): ExplorerRoot {
    const rootIds = new Set(items.map(item => UResource.makeResource(item.resource.uri).remoteId));
    if (rootIds.size !== 1) {
      throw new Error('Remote downloads only support items from the same remote root.');
    }

    const first = items[0];
    const root = app.remoteExplorer?.findRoot(first.resource.uri);
    if (!root || root.explorerContext.invalid) {
      throw new Error('The remote drag source is stale. Refresh Remote Explorer and try again.');
    }
    return root;
  }
}
