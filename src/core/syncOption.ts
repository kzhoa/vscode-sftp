export type SyncDirectionKey = 'toLocal' | 'toRemote';

export type SyncUpdateMode = 'always' | 'source-newer' | 'never';
export type SyncCompareMode = 'mtime-size' | 'hash';
export type SymbolicLinkMode = 'direct' | 'resolve' | 'ignore';
export type SyncUpdateInput =
  | SyncUpdateMode
  | boolean
  | 0
  | 1
  | '0'
  | '1';

export type SyncOptionValue<T> =
  | T
  | {
      toLocal?: T;
      toRemote?: T;
    };

export interface SyncOptionInput {
  create?: SyncOptionValue<boolean>;
  delete?: SyncOptionValue<boolean>;
  update?: SyncOptionValue<SyncUpdateInput>;
  compare?: SyncOptionValue<SyncCompareMode>;
  symbolicLink?: SymbolicLinkMode;
}

export interface NormalizedDirectionalSyncOption {
  create: Record<SyncDirectionKey, boolean>;
  delete: Record<SyncDirectionKey, boolean>;
  update: Record<SyncDirectionKey, SyncUpdateMode>;
  compare: Record<SyncDirectionKey, SyncCompareMode>;
  symbolicLink: SymbolicLinkMode;
}

export interface ResolvedSyncOption {
  create: boolean;
  delete: boolean;
  update: SyncUpdateMode;
  compare: SyncCompareMode;
  symbolicLink: SymbolicLinkMode;
}

export const DEFAULT_SYNC_OPTION: ResolvedSyncOption = {
  create: true,
  delete: false,
  update: 'source-newer',
  compare: 'mtime-size',
  symbolicLink: 'ignore',
};

const SYNC_DIRECTIONS: SyncDirectionKey[] = ['toLocal', 'toRemote'];

function isDirectionalObject<T>(
  value: SyncOptionValue<T> | undefined
): value is { toLocal?: T; toRemote?: T } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSyncUpdateMode(value: SyncUpdateInput): SyncUpdateMode {
  if (value === true || value === 1 || value === '1') {
    return 'source-newer';
  }
  if (value === false || value === 0 || value === '0') {
    return 'never';
  }
  return value;
}

function expandSyncOptionValue<TInput, TResolved>(
  value: SyncOptionValue<TInput> | undefined,
  base: Record<SyncDirectionKey, TResolved>,
  transform: (input: TInput) => TResolved
): Record<SyncDirectionKey, TResolved> {
  if (value === undefined) {
    return { ...base };
  }

  if (!isDirectionalObject(value)) {
    const resolved = transform(value);
    return {
      toLocal: resolved,
      toRemote: resolved,
    };
  }

  const result = { ...base };
  for (const direction of SYNC_DIRECTIONS) {
    const directionalValue = value[direction];
    if (directionalValue !== undefined) {
      result[direction] = transform(directionalValue);
    }
  }
  return result;
}

export function normalizeSyncOption(
  value?: SyncOptionInput,
  base: NormalizedDirectionalSyncOption = toNormalizedDirectionalSyncOption(
    DEFAULT_SYNC_OPTION
  )
): NormalizedDirectionalSyncOption {
  return {
    create: expandSyncOptionValue(value?.create, base.create, current => current),
    delete: expandSyncOptionValue(value?.delete, base.delete, current => current),
    update: expandSyncOptionValue(
      value?.update,
      base.update,
      normalizeSyncUpdateMode
    ),
    compare: expandSyncOptionValue(
      value?.compare,
      base.compare,
      current => current
    ),
    symbolicLink: value?.symbolicLink ?? base.symbolicLink,
  };
}

export function mergeSyncOptions(
  base: NormalizedDirectionalSyncOption,
  overlay?: SyncOptionInput
): NormalizedDirectionalSyncOption {
  return normalizeSyncOption(overlay, base);
}

export function toNormalizedDirectionalSyncOption(
  value: ResolvedSyncOption
): NormalizedDirectionalSyncOption {
  return {
    create: {
      toLocal: value.create,
      toRemote: value.create,
    },
    delete: {
      toLocal: value.delete,
      toRemote: value.delete,
    },
    update: {
      toLocal: value.update,
      toRemote: value.update,
    },
    compare: {
      toLocal: value.compare,
      toRemote: value.compare,
    },
    symbolicLink: value.symbolicLink,
  };
}

export function resolveSyncOptionForDirection(
  value: NormalizedDirectionalSyncOption,
  direction: SyncDirectionKey
): ResolvedSyncOption {
  return {
    create: value.create[direction],
    delete: value.delete[direction],
    update: value.update[direction],
    compare: value.compare[direction],
    symbolicLink: value.symbolicLink,
  };
}
