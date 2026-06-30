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
  runtime: RuntimeContext;
}

interface UploadTaskState {
  scheduler: Scheduler;
  status: 'QUEUED' | 'EXECUTING';
  latestTask: TransferTask;
  waitingBatches: Set<TransferBatch>;
  dirty: boolean;
  rerunScheduled: boolean;
  cancelled: boolean;
  runtime: RuntimeContext;
}

type LifecycleState = 'idle' | 'running' | 'reloading' | 'disposing' | 'disposed';
type UploadDedupMap = Map<string, UploadTaskState>;

interface RuntimeOperation {
  id: string;
  kind: 'transfer' | 'scheduler' | 'connect' | 'fs';
  generation: number;
  done: Promise<void>;
  cancel?: () => void;
  resolveDone: () => void;
}

interface RuntimeSnapshot {
  generation: number;
  config: ServiceConfig | null;
  configError: Error | null;
  profile: string | null;
  watcherConfig: WatcherConfig | null;
}

interface RuntimeHandles {
  transferSchedulers: Set<TransferScheduler>;
  pendingTransferTasks: Set<TransferTask>;
  dedupState: UploadDedupMap;
  operations: Map<string, RuntimeOperation>;
  cleanup: Set<() => Promise<void> | void>;
}

interface RuntimeContext {
  snapshot: RuntimeSnapshot;
  handles: RuntimeHandles;
  status: 'running' | 'draining' | 'stopped';
  acceptingWork: boolean;
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
  private _lifecyclePromise: Promise<void> = Promise.resolve();
  private _lifecycleState: LifecycleState = 'idle';
  private _operationSeq = 0;
  private _generationSeq = 0;
  private _runtime: RuntimeContext | null;
  private _drainingRuntimes: Set<RuntimeContext> = new Set();
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
    return this._getActiveRuntimes().reduce<TransferTask[]>((acc, runtime) => {
      acc.push(...runtime.handles.pendingTransferTasks);
      return acc;
    }, []);
  }

  isTransferring() {
    return this._getActiveRuntimes().some(runtime => {
      const handles = runtime.handles;
      return (
        handles.transferSchedulers.size > 0 ||
        handles.pendingTransferTasks.size > 0 ||
        handles.dedupState.size > 0
      );
    });
  }

  cancelTransferTasks() {
    this._getActiveRuntimes().forEach(runtime => {
      this._cancelRuntimeTasks(runtime);
    });
  }

  private _cancelRuntimeTasks(runtime: RuntimeContext) {
    runtime.handles.transferSchedulers.forEach(transfer => transfer.stop());
    runtime.handles.transferSchedulers.clear();
    runtime.handles.dedupState.forEach((state, key) => {
      state.cancelled = true;
      state.dirty = false;
      if (state.status === 'QUEUED') {
        this._settleUploadState(runtime, key, state);
      }
    });
    runtime.handles.pendingTransferTasks.forEach(task => task.cancel());
  }

  beforeTransfer(listener: (task: TransferTask) => void) {
    this._eventEmitter.on(Event.BEFORE_TRANSFER, listener);
  }

  afterTransfer(listener: (err: Error | null, task: TransferTask) => void) {
    this._eventEmitter.on(Event.AFTER_TRANSFER, listener);
  }

  createTransferScheduler(concurrency): TransferScheduler {
    const runtime = this._requireRuntimeAcceptingWork();
    const fileService = this;
    const scheduler = new Scheduler({
      autoStart: false,
      concurrency,
    });
    const batch = this._createTransferBatch(scheduler, runtime);
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
          fileService._removeScheduler(runtime, transferScheduler);
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
          fileService._emitBeforeTransfer(task, runtime.snapshot.generation);
          runtime.handles.pendingTransferTasks.add(task);
          let error: Error | null = null;
          try {
            await task.run();
          } catch (err) {
            error = err as Error;
            throw err;
          } finally {
            runtime.handles.pendingTransferTasks.delete(task);
            fileService._emitAfterTransfer(error, task, runtime.snapshot.generation);
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
          fileService._removeScheduler(runtime, transferScheduler);
          return Promise.resolve();
        }

        if (!batch.runPromise) {
          schedulerOperation = fileService._registerOperation(runtime, 'scheduler', () => transferScheduler.stop());
          batch.runPromise = new Promise(resolve => {
            batch.resolveRun = () => {
              batch.runPromise = null;
              batch.resolveRun = null;
              fileService._removeScheduler(runtime, transferScheduler);
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
    fileService._storeScheduler(runtime, transferScheduler);

    return transferScheduler;
  }

  getLocalFileSystem(): FileSystem {
    return localFs;
  }

  async withRemoteFileSystem<T>(
    config: ServiceConfig,
    action: (fileSystem: FileSystem) => Promise<T> | T
  ): Promise<T> {
    const runtime = this._requireRuntimeAcceptingWork();
    const operation = this._registerOperation(runtime, 'fs');

    if (config.protocol === 'local') {
      try {
        return await action(this.getLocalFileSystem());
      } finally {
        this._completeOperation(runtime, operation);
      }
    }

    const lease = await this._acquireRemoteLease(config, runtime);
    try {
      const remoteFs = await lease.getFileSystem();
      return await action(remoteFs);
    } finally {
      lease.release('released');
      this._completeOperation(runtime, operation);
    }
  }

  getConfig(useProfile?: string | null): ServiceConfig {
    const runtime = this._requireRuntime();
    if (useProfile === undefined || useProfile === runtime.snapshot.profile) {
      if (runtime.snapshot.configError) {
        throw runtime.snapshot.configError;
      }
      if (!runtime.snapshot.config) {
        throw new Error(`FileService runtime has no config snapshot for ${this.baseDir}`);
      }
      return runtime.snapshot.config;
    }
    return this._configStore.getResolved(this.baseDir, useProfile);
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
        this._drainingRuntimes.add(runtime);
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
        this._drainingRuntimes.add(runtime);
        await this._shutdownRuntime(runtime, reason);
      }
      this._lifecycleState = 'disposed';
    });
  }

  dispose(): Promise<void> {
    return this.requestDispose('service-disposed');
  }

  private _storeScheduler(runtime: RuntimeContext, scheduler: TransferScheduler) {
    runtime.handles.transferSchedulers.add(scheduler);
  }

  private _removeScheduler(runtime: RuntimeContext, scheduler: TransferScheduler) {
    runtime.handles.transferSchedulers.delete(scheduler);
    this._tryFinalizeDrainingRuntime(runtime);
  }

  private _createTransferBatch(scheduler: Scheduler, runtime: RuntimeContext): TransferBatch {
    return {
      pendingKeys: new Set(),
      queuedKeys: new Set(),
      scheduler,
      stopped: false,
      runPromise: null,
      resolveRun: null,
      runtime,
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

    const state = batch.runtime.handles.dedupState.get(key);
    if (!state) {
      const nextState: UploadTaskState = {
        scheduler: batch.scheduler,
        status: 'QUEUED',
        latestTask: task,
        waitingBatches: new Set([batch]),
        dirty: false,
        rerunScheduled: false,
        cancelled: false,
        runtime: batch.runtime,
      };
      batch.runtime.handles.dedupState.set(key, nextState);
      batch.scheduler.add(() => this._runUploadTask(batch.runtime, key));
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

  private async _runUploadTask(runtime: RuntimeContext, key: string) {
    const state = runtime.handles.dedupState.get(key);
    if (!state) {
      return;
    }

    const task = state.latestTask;
    const operation = this._registerOperation(runtime, 'transfer', () => task.cancel());
    state.status = 'EXECUTING';
    state.rerunScheduled = false;
    this._emitBeforeTransfer(task, runtime.snapshot.generation);
    runtime.handles.pendingTransferTasks.add(task);

    let error: Error | null = null;
    try {
      await task.run();
    } catch (err) {
      error = err as Error;
    } finally {
      runtime.handles.pendingTransferTasks.delete(task);
      this._emitAfterTransfer(error, task, runtime.snapshot.generation);
      this._completeOperation(runtime, operation);
    }

    const latestState = runtime.handles.dedupState.get(key);
    if (!latestState) {
      return;
    }

    if (latestState.cancelled) {
      this._settleUploadState(runtime, key, latestState);
      return;
    }

    if (latestState.dirty) {
      latestState.dirty = false;
      latestState.status = 'QUEUED';
      latestState.rerunScheduled = true;
      logger.debug(`[dedup] rerun scheduled after execution for ${latestState.latestTask.targetFsPath}`);
      latestState.scheduler.add(() => this._runUploadTask(runtime, key));
      return;
    }

    this._settleUploadState(runtime, key, latestState);
  }

  private _settleUploadState(runtime: RuntimeContext, key: string, state: UploadTaskState) {
    runtime.handles.dedupState.delete(key);
    state.waitingBatches.forEach(batch => {
      this._completeBatchKey(batch, key);
    });
    state.waitingBatches.clear();
    this._tryFinalizeDrainingRuntime(runtime);
  }

  private _enqueueLifecycle(action: () => Promise<void>): Promise<void> {
    const next = this._lifecyclePromise.then(action, action);
    this._lifecyclePromise = next;
    return next;
  }

  private async _shutdownRuntime(runtime: RuntimeContext, reason: string): Promise<void> {
    runtime.acceptingWork = false;
    runtime.status = 'draining';
    this._cancelRuntimeTasks(runtime);
    await this._awaitQuiesce(runtime, reason);
    await this._runRuntimeCleanup(runtime);

    runtime.status = 'stopped';
    this._tryFinalizeDrainingRuntime(runtime);
  }

  private async _awaitQuiesce(runtime: RuntimeContext, reason: string): Promise<void> {
    const snapshot = Array.from(runtime.handles.operations.values());
    if (snapshot.length <= 0) {
      return;
    }

    const timeout = new Promise<'timeout'>(resolve => {
      setTimeout(() => resolve('timeout'), this._shutdownTimeoutMs);
    });
    const settled = Promise.allSettled(snapshot.map(operation => operation.done)).then(() => 'settled' as const);
    const result = await Promise.race([settled, timeout]);
    if (result === 'timeout') {
      logger.warn(`[lifecycle] forced cleanup after timeout for ${this.baseDir} (${reason})`);
    }
  }

  private _createRuntime(): RuntimeContext {
    const entry = this._configStore.get(this.baseDir);
    const profile = this._configStore.getActiveProfile(this.baseDir);
    let config: ServiceConfig | null = null;
    let configError: Error | null = null;
    try {
      config = this._configStore.getResolved(this.baseDir, profile);
    } catch (error) {
      configError = error as Error;
    }
    return {
      snapshot: {
        generation: ++this._generationSeq,
        config,
        configError,
        profile,
        watcherConfig: entry?.rawConfig.watcher ?? null,
      },
      handles: {
        transferSchedulers: new Set(),
        pendingTransferTasks: new Set(),
        dedupState: new Map(),
        operations: new Map(),
        cleanup: new Set(),
      },
      status: 'running',
      acceptingWork: true,
    };
  }

  private async _acquireRemoteLease(
    config: ServiceConfig,
    runtime: RuntimeContext
  ): Promise<ConnectionLease> {
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
      id: `${runtime.snapshot.generation}:${kind}:${++this._operationSeq}`,
      kind,
      generation: runtime.snapshot.generation,
      done: new Promise(resolve => {
        resolveDone = resolve;
      }),
      cancel,
      resolveDone: () => resolveDone(),
    };
    runtime.handles.operations.set(operation.id, operation);
    return operation;
  }

  private _completeOperation(runtime: RuntimeContext, operation: RuntimeOperation) {
    if (!runtime.handles.operations.delete(operation.id)) {
      return;
    }
    operation.resolveDone();
    this._tryFinalizeDrainingRuntime(runtime);
  }

  private _emitBeforeTransfer(task: TransferTask, generation: number) {
    if (this._runtime?.snapshot.generation !== generation) {
      return;
    }
    this._eventEmitter.emit(Event.BEFORE_TRANSFER, task);
  }

  private _emitAfterTransfer(error: Error | null, task: TransferTask, generation: number) {
    if (this._runtime?.snapshot.generation !== generation) {
      return;
    }
    this._eventEmitter.emit(Event.AFTER_TRANSFER, error, task);
  }

  private _createWatcher(runtime: RuntimeContext) {
    if (runtime.snapshot.watcherConfig) {
      this._watcherService.create(this.baseDir, runtime.snapshot.watcherConfig);
      runtime.handles.cleanup.add(() => {
        this._watcherService.dispose(this.baseDir);
      });
    }
  }

  private async _runRuntimeCleanup(runtime: RuntimeContext) {
    const cleanup = Array.from(runtime.handles.cleanup);
    runtime.handles.cleanup.clear();
    await Promise.allSettled(cleanup.map(entry => Promise.resolve(entry())));
  }

  private _requireRuntime(): RuntimeContext {
    if (!this._runtime || this._lifecycleState === 'disposed') {
      throw new Error(`FileService is disposed for ${this.baseDir}`);
    }
    return this._runtime;
  }

  private _requireRuntimeAcceptingWork(): RuntimeContext {
    const runtime = this._requireRuntime();
    if (!runtime.acceptingWork || runtime.status !== 'running') {
      throw new Error(`FileService runtime is not accepting new work for ${this.baseDir}`);
    }
    return runtime;
  }

  private _getActiveRuntimes(): RuntimeContext[] {
    const runtimes = new Set(this._drainingRuntimes);
    if (this._runtime) {
      runtimes.add(this._runtime);
    }
    return Array.from(runtimes);
  }

  private _tryFinalizeDrainingRuntime(runtime: RuntimeContext) {
    if (!this._drainingRuntimes.has(runtime)) {
      return;
    }

    const handles = runtime.handles;
    if (
      handles.transferSchedulers.size > 0 ||
      handles.pendingTransferTasks.size > 0 ||
      handles.dedupState.size > 0 ||
      handles.operations.size > 0
    ) {
      return;
    }

    this._drainingRuntimes.delete(runtime);
  }
}
