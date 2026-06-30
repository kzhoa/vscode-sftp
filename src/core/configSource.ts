export interface ConfigSource {
  /** Read a file that must exist. Throws if not found. */
  readRequired(path: string): string;
  /** Read a file that may not exist. Returns null on missing/unreadable. */
  readOptional(path: string): string | null;
  /** Evict cached content for a path, or all paths if omitted. */
  invalidate?(path?: string): void;
}
