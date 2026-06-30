import * as fs from 'fs';
import fsCache from '../fsCache';
import logger from '../logger';
import type { ConfigSource } from '../core/configSource';

export const defaultConfigSource: ConfigSource = {
  readRequired(filePath: string): string {
    if (fsCache.has(filePath)) {
      return fsCache.get(filePath)!;
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `File ${filePath} not found. Check your config of "ignoreFile"`
      );
    }
    const content = fs.readFileSync(filePath).toString();
    fsCache.set(filePath, content);
    return content;
  },

  readOptional(filePath: string): string | null {
    if (fsCache.has(filePath)) {
      return fsCache.get(filePath)!;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      fsCache.set(filePath, content);
      return content;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn(`[configSource] failed to read ${filePath}: ${err?.message ?? err}`);
      }
      return null;
    }
  },

  invalidate(filePath?: string): void {
    if (filePath) {
      fsCache.delete(filePath);
    } else {
      fsCache.clear();
    }
  },
};
