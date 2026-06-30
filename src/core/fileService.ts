import { EventEmitter } from 'events';
import logger from '../logger';
import { FileSystem } from './fs';
import Scheduler from './scheduler';
import { createRemoteIfNoneExist, removeRemoteFs } from './remoteFs';
import TransferTask from './transferTask';
import localFs from './localFs';
import { getHostInfo } from './fileServiceConfig';
import type {
  ServiceConfig,
  WatcherConfig,
} from './fileServiceConfig';
import type { ConfigStore } from './configStore';

export type {
  FileServiceConfig,
  ServiceConfig,
  WatcherConfig,
} from './fileServiceConfig';

export interface WatcherService {
  create(watcherBase: string, watcherConfig: WatcherConfig): any;
  dispose(watcherBase: string): void;
}

interface TransferScheduler {
  size: number;
  add(x: TransferTask): void;
  run(): Promise<void>;
  stop(): void;
}

interface TransferBatch {
  pendingKeys: Set<string>;
  queuedKeys: Set<string>;
  scheduler: Scheduler;
  stopped: boolean;
  runPromise: Promise<void> | null;
  resolveRun: (() => void) | null;
}

interface UploadTaskState {
  scheduler: Scheduler;
  status: 'QUEUED' | 'EXECUTING';
  latestTask: TransferTask;
  waitingBatches: Set<TransferBatch>;
  dirty: boolean;
  rerunScheduled: boolean;
  cancelled: boolean;
}


enum Event {
  BEFORE_TRANSFER = 'BEFORE_TRANSFER',
  AFTER_TRANSFER = 'AFTER_TRANSFER',
}

let id = 0;

export default class FileService {
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _configStore: ConfigStore;
  private _pendingTransferTasks: Set<TransferTask> = new Set();
  private _transferSchedulers: TransferScheduler[] = [];
  private _uploadTaskStates: Map<string, UploadTaskState> = new Map();
  private _watcherService: WatcherService = {
    create() {},
    dispose() {},
  };
  private _connectedHostSignatures: Set<string> = new Set();
  private _lifecyclePromise: Promise<void> = Promise.resolve();
  private _isDisposed = false;
  id: number;
  baseDir: string;
  workspace: string;

  constructor(baseDir: string, workspace: string, configStore: ConfigStore) {
    this.id = ++id;
    this.workspace = workspace;
    this.baseDir = baseDir;
    this._configStore = configStore;
  }

  get name(): string {
    const entry = this._configStore.get(this.baseDir);
    return entry?.rawConfig.name || '';
  }

  setWatcherService(watcherService: WatcherService) {
    if (this._watcherService) {
      this._disposeWatcher();
    }

    this._watcherService = watcherService;
    this._createWatcher();
  }

  getAvailableProfiles(): string[] {
    const entry = this._configStore.get(this.baseDir);
    return entry?.profiles || [];
  }

  getInvalidProfiles(): Array<{ name: string; error: string }> {
    const entry = this._configStore.get(this.baseDir);
    return entry?.invalidProfiles || [];
  }

  getPendingTransferTasks(): TransferTask[] {
    return Array.from(this._pendingTransferTasks);
  }

  isTransferring() {
    return (
      this._transferSchedulers.length > 0 ||
      this._pendingTransferTasks.size > 0 ||
      this._uploadTaskStates.size > 0
    );
  }

  cancelTransferTasks() {
    this._transferSchedulers.forEach(transfer => transfer.stop());
    this._transferSchedulers.length = 0;
    this._uploadTaskStates.forEach((state, key) => {
      state.cancelled = true;
      state.dirty = false;
      if (state.status === 'QUEUED') {
        this._settleUploadState(key, state);
      }
    });
    this._pendingTransferTasks.forEach(task => task.cancel());
  }

  beforeTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.BEFORE_TRANSFER, listener);
  }

  afterTransfer(listener: (err: Error | null, task: TransferTask) => void) {
    this._eventEmitter.on(Event.AFTER_TRANSFER, listener);
  }

  createTransferScheduler(concurrency): TransferScheduler {
    const fileService = this;
    const scheduler = new Scheduler({
      autoStart: false,
      concurrency,
    });
    const batch = this._createTransferBatch(scheduler);
    const transferScheduler: TransferScheduler = {
      get size() {
        return batch.pendingKeys.size + scheduler.size + scheduler.pendingCount;
      },
      stop() {
        batch.stopped = true;
        scheduler.empty();
        fileService._clearQueuedBatchKeys(batch);
        if (batch.pendingKeys.size <= 0) {
          fileService._removeScheduler(transferScheduler);
          fileService._resolveBatch(batch);
        }
      },
      add(task: TransferTask) {
        if (batch.stopped) {
          return;
        }
        if (task.transferType === 'local ➞ remote') {
          fileService._addUploadTask(batch, task);
          return;
        }

        fileService._trackBatchKey(batch, fileService._createTaskKey(task));
        scheduler.add(async () => {
          fileService._markBatchKeyRunning(batch, fileService._createTaskKey(task));
          fileService._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
          fileService._pendingTransferTasks.add(task);
          let error: Error | null = null;
          try {
            await task.run();
          } catch (err) {
            error = err as Error;
            throw err;
          } finally {
            fileService._pendingTransferTasks.delete(task);
            fileService._eventEmitter.emit(Event.AFTER_TRANSFER, error, task);
            fileService._completeBatchKey(batch, fileService._createTaskKey(task));
          }
        });
      },
      run() {
        if (batch.stopped) {
          return Promise.resolve();
        }

        if (batch.pendingKeys.size <= 0) {
          fileService._removeScheduler(transferScheduler);
          return Promise.resolve();
        }

        if (!batch.runPromise) {
          batch.runPromise = new Promise(resolve => {
            batch.resolveRun = () => {
              batch.runPromise = null;
              batch.resolveRun = null;
              fileService._removeScheduler(transferScheduler);
              resolve();
            };
          });
          scheduler.start();
        }

        if (batch.pendingKeys.size <= 0) {
          fileService._resolveBatch(batch);
        }

        return batch.runPromise;
      },
    };
    fileService._storeScheduler(transferScheduler);

    return transferScheduler;
  }

  getLocalFileSystem(): FileSystem {
    return localFs;
  }

  getRemoteFileSystem(config: ServiceConfig): Promise<FileSystem> {
    const hostInfo = getHostInfo(config);
    this._connectedHostSignatures.add(JSON.stringify(hostInfo));
    return createRemoteIfNoneExist(hostInfo);
  }

  getConfig(useProfile?: string | null): ServiceConfig {
    const profile = useProfile !== undefined ? useProfile : this._configStore.getActiveProfile(this.baseDir);
    return this._configStore.getResolved(this.baseDir, profile);
  }

  invalidateConfigCache(): void {
    this._configStore.invalidate(this.baseDir);
  }

  reloadConfig(): Promise<void> {
    return this._enqueueLifecycle(async () => {
      if (this._isDisposed) {
        return;
      }

      await this._drainTransfers();
      this._disposeAllFileSystems();
      this._configStore.invalidate(this.baseDir);
      this._disposeWatcher();
      this._createWatcher();
    });
  }

  getAllConfig(): Array<ServiceConfig> {
    const entry = this._configStore.get(this.baseDir);
    if (!entry || entry.profiles.length === 0) {
      return [];
    }
    return entry.profiles.map(profile => this.getConfig(profile));
  }

  dispose(): Promise<void> {
    return this._enqueueLifecycle(async () => {
      if (this._isDisposed) {
        return;
      }

      this._isDisposed = true;
      await this._drainTransfers();
      this._disposeWatcher();
      this._disposeAllFileSystems();
    });
  }


  private _storeScheduler(scheduler: TransferScheduler) {
    this._transferSchedulers.push(scheduler);
  }

  private _removeScheduler(scheduler: TransferScheduler) {
    const index = this._transferSchedulers.findIndex(item => item === scheduler);
    if (index !== -1) {
      this._transferSchedulers.splice(index, 1);
    }
  }

  private _createTransferBatch(scheduler: Scheduler): TransferBatch {
    return {
      pendingKeys: new Set(),
      queuedKeys: new Set(),
      scheduler,
      stopped: false,
      runPromise: null,
      resolveRun: null,
    };
  }

  private _createTaskKey(task: TransferTask) {
    return `${task.transferType}:${task.schedulingKey}`;
  }

  private _trackBatchKey(batch: TransferBatch, key: string) {
    batch.pendingKeys.add(key);
    batch.queuedKeys.add(key);
  }

  private _markBatchKeyRunning(batch: TransferBatch, key: string) {
    batch.queuedKeys.delete(key);
  }

  private _completeBatchKey(batch: TransferBatch, key: string) {
    batch.queuedKeys.delete(key);
    if (!batch.pendingKeys.delete(key)) {
      return;
    }

    if (batch.pendingKeys.size <= 0) {
      this._resolveBatch(batch);
    }
  }

  private _resolveBatch(batch: TransferBatch) {
    if (batch.resolveRun) {
      batch.resolveRun();
    }
  }

  private _clearQueuedBatchKeys(batch: TransferBatch) {
    batch.queuedKeys.forEach(key => {
      batch.pendingKeys.delete(key);
    });
    batch.queuedKeys.clear();
  }

  private _addUploadTask(batch: TransferBatch, task: TransferTask) {
    const key = this._createTaskKey(task);
    this._trackBatchKey(batch, key);

    const state = this._uploadTaskStates.get(key);
    if (!state) {
      const nextState: UploadTaskState = {
        scheduler: batch.scheduler,
        status: 'QUEUED',
        latestTask: task,
        waitingBatches: new Set([batch]),
        dirty: false,
        rerunScheduled: false,
        cancelled: false,
      };
      this._uploadTaskStates.set(key, nextState);
      batch.scheduler.add(() => this._runUploadTask(key));
      return;
    }

    state.waitingBatches.add(batch);
    if (state.status === 'QUEUED') {
      state.latestTask = task;
      logger.debug(`[dedup] queued task replaced for ${task.targetFsPath}`);
      return;
    }

    state.latestTask = task;
    state.dirty = true;
    logger.debug(`[dedup] in-flight task marked dirty for ${task.targetFsPath}`);
  }

  private async _runUploadTask(key: string) {
    const state = this._uploadTaskStates.get(key);
    if (!state) {
      return;
    }

    const task = state.latestTask;
    state.status = 'EXECUTING';
    state.rerunScheduled = false;
    this._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
    this._pendingTransferTasks.add(task);

    let error: Error | null = null;
    try {
      await task.run();
    } catch (err) {
      error = err as Error;
    } finally {
      this._pendingTransferTasks.delete(task);
      this._eventEmitter.emit(Event.AFTER_TRANSFER, error, task);
    }

    const latestState = this._uploadTaskStates.get(key);
    if (!latestState) {
      return;
    }

    if (latestState.cancelled) {
      this._settleUploadState(key, latestState);
      return;
    }

    if (latestState.dirty) {
      latestState.dirty = false;
      latestState.status = 'QUEUED';
      latestState.rerunScheduled = true;
      logger.debug(`[dedup] rerun scheduled after execution for ${latestState.latestTask.targetFsPath}`);
      latestState.scheduler.add(() => this._runUploadTask(key));
      return;
    }

    this._settleUploadState(key, latestState);
  }

  private _settleUploadState(key: string, state: UploadTaskState) {
    this._uploadTaskStates.delete(key);
    state.waitingBatches.forEach(batch => {
      this._completeBatchKey(batch, key);
    });
    state.waitingBatches.clear();
  }

  private _enqueueLifecycle(action: () => Promise<void>): Promise<void> {
    const next = this._lifecyclePromise.then(action, action);
    this._lifecyclePromise = next;
    return next;
  }

  private async _drainTransfers(): Promise<void> {
    this.cancelTransferTasks();
    while (this.isTransferring()) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }


  private _createWatcher() {
    const entry = this._configStore.get(this.baseDir);
    const watcherConfig = entry?.rawConfig.watcher;
    if (watcherConfig) {
      this._watcherService.create(this.baseDir, watcherConfig);
    }
  }

  private _disposeWatcher() {
    this._watcherService.dispose(this.baseDir);
  }

  private _disposeAllFileSystems() {
    for (const key of this._connectedHostSignatures) {
      removeRemoteFs(JSON.parse(key));
    }
    this._connectedHostSignatures.clear();
  }
}
