type Id = number;

export interface RootIdEntry {
  id: Id;
  baseDir: string;
  profile: string | null;
}

let nextStableId = 0;
const keyToId: Map<string, Id> = new Map();
const idToEntry: Map<Id, RootIdEntry> = new Map();

function makeKey(baseDir: string, profile: string | null): string {
  return `${baseDir}::${profile ?? ''}`;
}

export function getStableRootId(baseDir: string, profile: string | null): Id {
  const key = makeKey(baseDir, profile);
  let id = keyToId.get(key);
  if (id === undefined) {
    id = ++nextStableId;
    keyToId.set(key, id);
    idToEntry.set(id, { id, baseDir, profile });
  }
  return id;
}

export function resolveRootEntry(rootId: Id): RootIdEntry | undefined {
  return idToEntry.get(rootId);
}

export function findRootIdByProfile(baseDir: string, profile: string | null): Id | undefined {
  return keyToId.get(makeKey(baseDir, profile));
}
