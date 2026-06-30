import { EventEmitter } from 'events';
import logger from '../logger';
import { FileSystem } from './fs';
import Scheduler from './scheduler';
import TransferTask from './transferTask';
import localFs from './localFs';
import { createConnectionSpec } from './fileServiceConfig';
import { ConnectionPool, type ConnectionLease } from './connectionPool';
import type {
  ServiceConfig,
  WatcherConfig,
} from './fileServiceConfig';
import type { ConfigStore } from './configStore';
import type { RemoteConnectionObserver } from './remoteConnectionEvent';

export type {
  FileServiceConfig,
  ServiceConfig,
  WatcherConfig,
} from './fileServiceConfig';

export interface WatcherService {
  create(watcherBase: string, watcherConfig: WatcherConfig): any;
  dispose(watcherBase: string): void;
}

export interface FileServiceDependencies {
  configStore: ConfigStore;
  watcherService: WatcherService;
  connectionPool: ConnectionPool;
  connectionObserver?: RemoteConnectionObserver;
  shutdownTimeoutMs?: number;
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
  runtimeGeneration: number;
}

interface UploadTaskState {
  scheduler: Scheduler;
  status: 'QUEUED' | 'EXECUTING';
  latestTask: TransferTask;
  waitingBatches: Set<TransferBatch>;
  dirty: boolean;
  rerunScheduled: boolean;
  cancelled: boolean;
  runtimeGeneration: number;
}

type LifecycleState = 'idle' | 'running' | 'reloading' | 'disposing' | 'disposed';

interface RuntimeOperation {
  id: string;
  kind: 'transfer' | 'scheduler' | 'connect';
  generation: number;
  done: Promise<void>;
  cancel?: () => void;
  resolveDone: () => void;
}

interface RuntimeContext {
  generation: number;
  watcherConfig: WatcherConfig | null;
  status: 'running' | 'draining' | 'stopped';
  acceptingWork: boolean;
  operations: Map<string, RuntimeOperation>;
}

enum Event {
  BEFORE_TRANSFER = 'BEFORE_TRANSFER',
  AFTER_TRANSFER = 'AFTER_TRANSFER',
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let id = 0;

export default class FileService {
  private _eventEmitter: EventEmitter = new EventEmitter();
  private _configStore: ConfigStore;
  private _watcherService: WatcherService;
  private _connectionPool: ConnectionPool;
  private _connectionObserver: RemoteConnectionObserver | undefined;
  private _shutdownTimeoutMs: number;
  private _pendingTransferTasks: Set<TransferTask> = new Set();
  private _transferSchedulers: TransferScheduler[] = [];
  private _uploadTaskStates: Map<string, UploadTaskState> = new Map();
  private _lifecyclePromise: Promise<void> = Promise.resolve();
  private _lifecycleState: LifecycleState = 'idle';
  private _operationSeq = 0;
  private _generationSeq = 0;
  private _runtime: RuntimeContext | null;
  id: number;
  baseDir: string;
  workspace: string;

  constructor(
    baseDir: string,
    workspace: string,
    dependencies: FileServiceDependencies
  ) {
    this.id = ++id;
    this.workspace = workspace;
    this.baseDir = baseDir;
    this._configStore = dependencies.configStore;
    this._watcherService = dependencies.watcherService;
    this._connectionPool = dependencies.connectionPool;
    this._connectionObserver = dependencies.connectionObserver;
    this._shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this._runtime = this._createRuntime();
    this._createWatcher(this._runtime);
    this._lifecycleState = 'running';
  }

  get name(): string {
    const entry = this._configStore.get(this.baseDir);
    return entry?.rawConfig.name || '';
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
    const runtime = this._requireRuntime();
    const fileService = this;
    const scheduler = new Scheduler({
      autoStart: false,
      concurrency,
    });
    const batch = this._createTransferBatch(scheduler, runtime.generation);
    let schedulerOperation: RuntimeOperation | null = null;

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
          const operation = fileService._registerOperation(runtime, 'transfer', () => task.cancel());
          fileService._markBatchKeyRunning(batch, fileService._createTaskKey(task));
          fileService._emitBeforeTransfer(task, runtime.generation);
          fileService._pendingTransferTasks.add(task);
          let error: Error | null = null;
          try {
            await task.run();
          } catch (err) {
            error = err as Error;
            throw err;
          } finally {
            fileService._pendingTransferTasks.delete(task);
            fileService._emitAfterTransfer(error, task, runtime.generation);
            fileService._completeBatchKey(batch, fileService._createTaskKey(task));
            fileService._completeOperation(runtime, operation);
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
          schedulerOperation = fileService._registerOperation(runtime, 'scheduler', () => transferScheduler.stop());
          batch.runPromise = new Promise(resolve => {
            batch.resolveRun = () => {
              batch.runPromise = null;
              batch.resolveRun = null;
              fileService._removeScheduler(transferScheduler);
              if (schedulerOperation) {
                fileService._completeOperation(runtime, schedulerOperation);
                schedulerOperation = null;
              }
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

  async withRemoteFileSystem<T>(
    config: ServiceConfig,
    action: (fileSystem: FileSystem) => Promise<T> | T
  ): Promise<T> {
    if (config.protocol === 'local') {
      return action(this.getLocalFileSystem());
    }

    const lease = await this._acquireRemoteLease(config);
    try {
      const remoteFs = await lease.getFileSystem();
      return await action(remoteFs);
    } finally {
      lease.release('released');
    }
  }

  getConfig(useProfile?: string | null): ServiceConfig {
    const profile = useProfile !== undefined ? useProfile : this._configStore.getActiveProfile(this.baseDir);
    return this._configStore.getResolved(this.baseDir, profile);
  }

  invalidateConfigCache(): void {
    this._configStore.invalidate(this.baseDir);
  }

  requestReload(reason: string = 'config-changed'): Promise<void> {
    return this._enqueueLifecycle(async () => {
      if (this._lifecycleState === 'disposed') {
        return;
      }

      this._lifecycleState = 'reloading';
      const runtime = this._runtime;
      if (runtime) {
        await this._shutdownRuntime(runtime, reason);
      }
      this._configStore.invalidate(this.baseDir);
      this._runtime = this._createRuntime();
      this._createWatcher(this._runtime);
      this._lifecycleState = 'running';
    });
  }

  reloadConfig(): Promise<void> {
    return this.requestReload('config-changed');
  }

  getAllConfig(): Array<ServiceConfig> {
    const entry = this._configStore.get(this.baseDir);
    if (!entry || entry.profiles.length === 0) {
      return [];
    }
    return entry.profiles.map(profile => this.getConfig(profile));
  }

  requestDispose(reason: string = 'service-disposed'): Promise<void> {
    return this._enqueueLifecycle(async () => {
      if (this._lifecycleState === 'disposed') {
        return;
      }

      this._lifecycleState = 'disposing';
      const runtime = this._runtime;
      this._runtime = null;
      if (runtime) {
        await this._shutdownRuntime(runtime, reason);
      }
      this._lifecycleState = 'disposed';
    });
  }

  dispose(): Promise<void> {
    return this.requestDispose('service-disposed');
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

  private _createTransferBatch(scheduler: Scheduler, runtimeGeneration: number): TransferBatch {
    return {
      pendingKeys: new Set(),
      queuedKeys: new Set(),
      scheduler,
      stopped: false,
      runPromise: null,
      resolveRun: null,
      runtimeGeneration,
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
        runtimeGeneration: batch.runtimeGeneration,
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

    const runtime = this._findRuntimeByGeneration(state.runtimeGeneration);
    const task = state.latestTask;
    const operation = runtime ? this._registerOperation(runtime, 'transfer', () => task.cancel()) : null;
    state.status = 'EXECUTING';
    state.rerunScheduled = false;
    this._emitBeforeTransfer(task, state.runtimeGeneration);
    this._pendingTransferTasks.add(task);

    let error: Error | null = null;
    try {
      await task.run();
    } catch (err) {
      error = err as Error;
    } finally {
      this._pendingTransferTasks.delete(task);
      this._emitAfterTransfer(error, task, state.runtimeGeneration);
      if (runtime && operation) {
        this._completeOperation(runtime, operation);
      }
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

  private async _shutdownRuntime(runtime: RuntimeContext, releaseReason: string): Promise<void> {
    runtime.acceptingWork = false;
    runtime.status = 'draining';
    this.cancelTransferTasks();
    await this._awaitQuiesce(runtime);
    this._disposeWatcher();

    runtime.status = 'stopped';
  }

  private async _awaitQuiesce(runtime: RuntimeContext): Promise<void> {
    const snapshot = Array.from(runtime.operations.values());
    if (snapshot.length <= 0) {
      return;
    }

    const timeout = new Promise<'timeout'>(resolve => {
      setTimeout(() => resolve('timeout'), this._shutdownTimeoutMs);
    });
    const settled = Promise.allSettled(snapshot.map(operation => operation.done)).then(() => 'settled' as const);
    const result = await Promise.race([settled, timeout]);
    if (result === 'timeout') {
      logger.warn(`[lifecycle] forced cleanup after timeout for ${this.baseDir}`);
    }
  }

  private _createRuntime(): RuntimeContext {
    const entry = this._configStore.get(this.baseDir);
    return {
      generation: ++this._generationSeq,
      watcherConfig: entry?.rawConfig.watcher ?? null,
      status: 'running',
      acceptingWork: true,
      operations: new Map(),
    };
  }

  private async _acquireRemoteLease(config: ServiceConfig): Promise<ConnectionLease> {
    const runtime = this._requireRuntime();
    if (!runtime.acceptingWork) {
      throw new Error(`FileService runtime is not accepting new work for ${this.baseDir}`);
    }

    const spec = createConnectionSpec(config);
    const operation = this._registerOperation(runtime, 'connect');
    return this._connectionPool
      .acquire(spec, this._connectionObserver)
      .then(
        lease => {
          if (
            this._runtime !== runtime ||
            runtime.status !== 'running' ||
            !runtime.acceptingWork
          ) {
            lease.release('runtime-disposed');
            throw new Error(`Stale connection acquisition for ${this.baseDir}`);
          }
          return lease;
        },
        error => {
          throw error;
        }
      )
      .finally(() => {
        this._completeOperation(runtime, operation);
      });
  }

  private _registerOperation(
    runtime: RuntimeContext,
    kind: RuntimeOperation['kind'],
    cancel?: () => void
  ): RuntimeOperation {
    let resolveDone: () => void = () => {};
    const operation: RuntimeOperation = {
      id: `${runtime.generation}:${kind}:${++this._operationSeq}`,
      kind,
      generation: runtime.generation,
      done: new Promise(resolve => {
        resolveDone = resolve;
      }),
      cancel,
      resolveDone: () => resolveDone(),
    };
    runtime.operations.set(operation.id, operation);
    return operation;
  }

  private _completeOperation(runtime: RuntimeContext, operation: RuntimeOperation) {
    if (!runtime.operations.delete(operation.id)) {
      return;
    }
    operation.resolveDone();
  }

  private _emitBeforeTransfer(task: TransferTask, generation: number) {
    if (this._runtime?.generation !== generation) {
      return;
    }
    this._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
  }

  private _emitAfterTransfer(error: Error | null, task: TransferTask, generation: number) {
    if (this._runtime?.generation !== generation) {
      return;
    }
    this._eventEmitter.emit(Event.AFTER_TRANSFER, error, task);
  }

  private _createWatcher(runtime: RuntimeContext) {
    if (runtime.watcherConfig) {
      this._watcherService.create(this.baseDir, runtime.watcherConfig);
    }
  }

  private _disposeWatcher() {
    this._watcherService.dispose(this.baseDir);
  }

  private _requireRuntime(): RuntimeContext {
    if (!this._runtime || this._lifecycleState === 'disposed') {
      throw new Error(`FileService is disposed for ${this.baseDir}`);
    }
    return this._runtime;
  }

  private _findRuntimeByGeneration(generation: number): RuntimeContext | null {
    if (this._runtime?.generation === generation) {
      return this._runtime;
    }
    return null;
  }
}
