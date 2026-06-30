import { EventEmitter } from 'events';
import type { ValidationError } from 'joi';
import type { FileServiceConfig, ServiceConfig } from './fileServiceConfig';
import { resolveConfig } from './configResolver';
import logger from '../logger';

export type ConfigId = string;
export type ConfigValidator = (config: FileServiceConfig) => ValidationError | undefined;

export interface InvalidProfile {
  name: string;
  error: string;
}

export interface ConfigEntry {
  id: ConfigId;
  workspace: string;
  rawConfig: FileServiceConfig;
  profiles: string[];
  invalidProfiles: InvalidProfile[];
}

interface ConfigCandidate {
  entries: Map<ConfigId, ConfigEntry>;
  activeProfiles: Map<ConfigId, string | null>;
}

interface ConfigDiff {
  removed: ConfigId[];
  added: ConfigEntry[];
  changed: ConfigId[];
  activeProfileChanged: ConfigId[];
}

interface LoadInitialOptions {
  validator: ConfigValidator;
}

type WorkspaceConfigInput = Array<{ id: ConfigId; rawConfig: FileServiceConfig }>;

export type ReloadWorkspaceResult =
  | { ok: true }
  | { ok: false; errors: Array<{ id: ConfigId; error: Error }> };

export class ConfigStore {
  private _entries = new Map<ConfigId, ConfigEntry>();
  private _activeProfiles = new Map<ConfigId, string | null>();
  private _resolvedCache = new Map<string, ServiceConfig>();
  private _validator: ConfigValidator | null = null;
  private _emitter = new EventEmitter();

  loadInitial(
    workspace: string,
    configs: WorkspaceConfigInput,
    options: LoadInitialOptions
  ): void {
    if (!options.validator) {
      throw new Error('ConfigStore.loadInitial requires a validator.');
    }

    if (!this._validator) {
      this._validator = options.validator;
    }

    const validation = this._validateBaseConfigs(configs);
    if (validation.length > 0) {
      throw validation[0].error;
    }

    const candidate = this._buildWorkspaceCandidate(workspace, configs);
    this._commitCandidate(candidate);
  }

  reloadWorkspace(
    workspace: string,
    configs: WorkspaceConfigInput
  ): ReloadWorkspaceResult {
    const validation = this._validateBaseConfigs(configs);
    if (validation.length > 0) {
      return {
        ok: false,
        errors: validation,
      };
    }

    const candidate = this._buildWorkspaceCandidate(workspace, configs);
    this._commitCandidate(candidate);
    return { ok: true };
  }

  get(id: ConfigId): ConfigEntry | undefined {
    return this._entries.get(id);
  }

  getAll(): ConfigEntry[] {
    return Array.from(this._entries.values());
  }

  getByWorkspace(workspace: string): ConfigEntry[] {
    return this.getAll().filter(entry => entry.workspace === workspace);
  }

  getResolved(id: ConfigId, profile?: string | null): ServiceConfig {
    const resolvedProfile = profile === undefined
      ? this.getActiveProfile(id)
      : profile;
    const cacheKey = `${id}::${resolvedProfile ?? '__default__'}`;
    const cached = this._resolvedCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const entry = this._entries.get(id);
    if (!entry) {
      throw new Error(`ConfigStore: no entry found for id "${id}"`);
    }

    const resolved = resolveConfig(entry.rawConfig, {
      profile: resolvedProfile,
      workspace: entry.workspace,
      baseDir: id,
      validator: this._validator ?? undefined,
    });
    this._resolvedCache.set(cacheKey, resolved);
    return resolved;
  }

  getActiveProfile(id: ConfigId): string | null {
    return this._activeProfiles.get(id) ?? null;
  }

  setActiveProfile(id: ConfigId, profile: string | null): void {
    const entry = this._entries.get(id);
    if (!entry) {
      return;
    }
    if (profile !== null && !entry.profiles.includes(profile)) {
      return;
    }

    const current = this.getActiveProfile(id);
    if (current === profile) {
      return;
    }

    this._activeProfiles.set(id, profile);
    this._emitter.emit('activeProfileChanged', [id]);
  }

  setActiveProfileAll(profile: string | null): void {
    const changedIds: ConfigId[] = [];

    for (const [id, entry] of this._entries) {
      if (profile !== null && !entry.profiles.includes(profile)) {
        continue;
      }

      const current = this.getActiveProfile(id);
      if (current === profile) {
        continue;
      }

      this._activeProfiles.set(id, profile);
      changedIds.push(id);
    }

    if (changedIds.length > 0) {
      this._emitter.emit('activeProfileChanged', changedIds);
    }
  }

  invalidate(id?: ConfigId): void {
    if (id) {
      this._invalidateById(id);
      return;
    }

    this._resolvedCache.clear();
  }

  onAdded(listener: (entry: ConfigEntry) => void): void {
    this._emitter.on('added', listener);
  }

  onRemoved(listener: (id: ConfigId) => void): void {
    this._emitter.on('removed', listener);
  }

  onChanged(listener: (ids: ConfigId[]) => void): void {
    this._emitter.on('changed', listener);
  }

  onActiveProfileChanged(listener: (ids: ConfigId[]) => void): void {
    this._emitter.on('activeProfileChanged', listener);
  }

  private _validateBaseConfigs(
    configs: WorkspaceConfigInput
  ): Array<{ id: ConfigId; error: Error }> {
    if (!this._validator) {
      return [];
    }

    const errors: Array<{ id: ConfigId; error: Error }> = [];
    for (const { id, rawConfig } of configs) {
      const validationError = this._validator(rawConfig);
      if (validationError) {
        errors.push({
          id,
          error: new Error(`Config validation fail: ${validationError.message}`),
        });
      }
    }
    return errors;
  }

  private _buildWorkspaceCandidate(
    workspace: string,
    configs: WorkspaceConfigInput
  ): ConfigCandidate {
    const entries = new Map(this._entries);
    const activeProfiles = new Map(this._activeProfiles);
    const incomingIds = new Set(configs.map(config => config.id));

    for (const { id, rawConfig } of configs) {
      const { valid, invalid } = this._resolveProfiles(id, rawConfig, workspace);
      const nextEntry: ConfigEntry = {
        id,
        workspace,
        rawConfig,
        profiles: valid,
        invalidProfiles: invalid,
      };
      entries.set(id, nextEntry);

      const currentActiveProfile = activeProfiles.get(id);
      activeProfiles.set(
        id,
        this._reconcileActiveProfile(currentActiveProfile, nextEntry.profiles, nextEntry.rawConfig.defaultProfile)
      );
    }

    for (const existing of this.getByWorkspace(workspace)) {
      if (!incomingIds.has(existing.id)) {
        entries.delete(existing.id);
        activeProfiles.delete(existing.id);
      }
    }

    return { entries, activeProfiles };
  }

  private _commitCandidate(candidate: ConfigCandidate): void {
    const diff = this._diffCandidate(candidate);

    this._entries = candidate.entries;
    this._activeProfiles = candidate.activeProfiles;
    this._resolvedCache = new Map();

    for (const id of diff.removed) {
      this._emitter.emit('removed', id);
    }
    for (const entry of diff.added) {
      this._emitter.emit('added', entry);
    }
    if (diff.changed.length > 0) {
      this._emitter.emit('changed', diff.changed);
    }
    if (diff.activeProfileChanged.length > 0) {
      this._emitter.emit('activeProfileChanged', diff.activeProfileChanged);
    }
  }

  private _diffCandidate(candidate: ConfigCandidate): ConfigDiff {
    const removed: ConfigId[] = [];
    const added: ConfigEntry[] = [];
    const changed: ConfigId[] = [];
    const activeProfileChanged = new Set<ConfigId>();

    for (const [id, currentEntry] of this._entries) {
      if (!candidate.entries.has(id)) {
        removed.push(id);
        activeProfileChanged.add(id);
        continue;
      }

      const nextEntry = candidate.entries.get(id)!;
      if (!this._isSameEntry(currentEntry, nextEntry)) {
        changed.push(id);
      }

      const currentProfile = this.getActiveProfile(id);
      const nextProfile = candidate.activeProfiles.get(id) ?? null;
      if (currentProfile !== nextProfile) {
        activeProfileChanged.add(id);
      }
    }

    for (const [id, nextEntry] of candidate.entries) {
      if (!this._entries.has(id)) {
        added.push(nextEntry);
        if ((candidate.activeProfiles.get(id) ?? null) !== null) {
          activeProfileChanged.add(id);
        }
      }
    }

    return {
      removed,
      added,
      changed,
      activeProfileChanged: Array.from(activeProfileChanged),
    };
  }

  private _resolveProfiles(
    id: ConfigId,
    rawConfig: FileServiceConfig,
    workspace: string
  ): { valid: string[]; invalid: InvalidProfile[] } {
    const allKeys = rawConfig.profiles ? Object.keys(rawConfig.profiles) : [];
    if (allKeys.length === 0 || !this._validator) {
      return { valid: allKeys, invalid: [] };
    }

    const valid: string[] = [];
    const invalid: InvalidProfile[] = [];
    for (const profile of allKeys) {
      try {
        resolveConfig(rawConfig, {
          profile,
          workspace,
          baseDir: id,
          validator: this._validator,
        });
        valid.push(profile);
      } catch (err) {
        const message = (err as Error).message;
        logger.warn(`[config] profile "${profile}" invalid: ${message}`);
        invalid.push({ name: profile, error: message });
      }
    }

    return { valid, invalid };
  }

  private _reconcileActiveProfile(
    current: string | null | undefined,
    profiles: string[],
    defaultProfile?: string
  ): string | null {
    if (current && profiles.includes(current)) {
      return current;
    }

    if (defaultProfile && profiles.includes(defaultProfile)) {
      return defaultProfile;
    }

    return null;
  }

  private _invalidateById(id: ConfigId): void {
    const prefix = `${id}::`;
    for (const key of this._resolvedCache.keys()) {
      if (key.startsWith(prefix)) {
        this._resolvedCache.delete(key);
      }
    }
  }

  private _isSameEntry(a: ConfigEntry, b: ConfigEntry): boolean {
    return a.id === b.id &&
      a.workspace === b.workspace &&
      this._jsonEquals(a.rawConfig, b.rawConfig) &&
      this._jsonEquals(a.profiles, b.profiles) &&
      this._jsonEquals(a.invalidProfiles, b.invalidProfiles);
  }

  private _jsonEquals(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
