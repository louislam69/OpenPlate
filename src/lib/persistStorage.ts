import type { DiaryEntry } from './types';

/**
 * Persistence for the app state without one ever-growing value.
 *
 * Diary entries are stored per month under `<name>:entries:YYYY-MM`; everything else stays under
 * `<name>`. Only months that actually changed are written, so logging food rewrites one small
 * value instead of the whole history, and no single value grows past Android's ~2 MB row limit.
 *
 * Old installs kept the entries inside the main value; they are read from there until the first
 * write moves them into month values.
 */

/** The subset of AsyncStorage this needs (an in-memory version is used in tests). */
export interface KeyValueStore {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiSet(pairs: [string, string][]): Promise<void>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

export interface StoredValue<S> {
  state: S;
  version?: number;
}

type WithEntries = { entries?: DiaryEntry[] };

const monthOf = (date: string) => date.slice(0, 7);
const shardPrefix = (name: string) => `${name}:entries:`;

/** Groups diary entries by month (YYYY-MM). */
export function splitEntries(entries: DiaryEntry[]): Map<string, DiaryEntry[]> {
  const out = new Map<string, DiaryEntry[]>();
  for (const e of entries) {
    const m = monthOf(e.date);
    const list = out.get(m);
    if (list) list.push(e);
    else out.set(m, [e]);
  }
  return out;
}

export function createShardedStorage<S extends WithEntries>(kv: KeyValueStore) {
  /** Last JSON written or read per key, to skip unchanged writes. */
  const written = new Map<string, string>();
  /** Writes stay in order even though zustand does not wait for them. */
  let queue: Promise<void> = Promise.resolve();
  /** Nothing is written before the stored data was read successfully, so a failed read can never
   * be followed by an empty state overwriting the user's history. */
  let loaded = false;

  return {
    async getItem(name: string): Promise<StoredValue<S> | null> {
      const keys = await kv.getAllKeys();
      const prefix = shardPrefix(name);
      const shardKeys = keys.filter((k) => k.startsWith(prefix)).sort();
      const pairs = await kv.multiGet([name, ...shardKeys]);
      written.clear();
      let main: (StoredValue<S> & { entriesSharded?: boolean }) | null = null;
      const entries: DiaryEntry[] = [];
      for (const [key, raw] of pairs) {
        if (raw === null) continue;
        written.set(key, raw);
        if (key === name) main = JSON.parse(raw);
        else entries.push(...(JSON.parse(raw) as DiaryEntry[]));
      }
      loaded = true;
      if (!main) return null;
      // Month values win once they exist; a legacy main value may still hold an old copy.
      const legacy = main.state.entries ?? [];
      const all = shardKeys.length || main.entriesSharded ? entries : legacy;
      return { state: { ...main.state, entries: all }, version: main.version };
    },

    setItem(name: string, value: StoredValue<S>): Promise<void> {
      if (!loaded) return queue;
      const { entries = [], ...rest } = value.state;
      const prefix = shardPrefix(name);
      const sets: [string, string][] = [];
      const removes: string[] = [];

      const months = splitEntries(entries);
      for (const [month, list] of months) {
        const key = prefix + month;
        const json = JSON.stringify(list);
        if (written.get(key) !== json) {
          sets.push([key, json]);
          written.set(key, json);
        }
      }
      for (const key of [...written.keys()]) {
        if (key.startsWith(prefix) && !months.has(key.slice(prefix.length))) {
          removes.push(key);
          written.delete(key);
        }
      }
      const mainJson = JSON.stringify({ state: rest, version: value.version, entriesSharded: true });
      if (written.get(name) !== mainJson) {
        // Month values are written first: if the app dies in between, the old main value is still valid.
        sets.push([name, mainJson]);
        written.set(name, mainJson);
      }

      if (!sets.length && !removes.length) return queue;
      queue = queue
        .then(async () => {
          if (sets.length) await kv.multiSet(sets);
          if (removes.length) await kv.multiRemove(removes);
        })
        .catch((e) => {
          // Forget what we think is stored so the next change rewrites everything.
          written.clear();
          console.warn('OpenPlate: saving failed', e);
        });
      return queue;
    },

    async removeItem(name: string): Promise<void> {
      const keys = await kv.getAllKeys();
      await kv.multiRemove(keys.filter((k) => k === name || k.startsWith(shardPrefix(name))));
      written.clear();
    },

    /** Waits for pending writes (tests, export). */
    flush: () => queue,
  };
}

/** In-memory KeyValueStore for tests. */
export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getAllKeys: async () => [...data.keys()],
    multiGet: async (keys) => keys.map((k) => [k, data.get(k) ?? null] as const),
    multiSet: async (pairs) => {
      for (const [k, v] of pairs) data.set(k, v);
    },
    multiRemove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
}
