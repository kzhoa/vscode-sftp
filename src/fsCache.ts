import { LRUCache } from 'lru-cache';

const fsCache = new LRUCache<string, string>({ max: 6 });

export default fsCache;
