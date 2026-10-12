import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_AI_SETTINGS } from './ai';
import type { Backup } from './backup';
import { newId } from './id';
import { migrateState, STORE_VERSION } from './migrations';
import { createShardedStorage } from './persistStorage';
import type {
  AIProviderConfig,
  AIProviderId,
  AISettings,
  DiaryEntry,
  FastingSession,
  Food,
  LanguagePref,
  MealType,
  PersistedData,
  Profile,
} from './types';

const MAX_RECENT = 40;

type PersistedState = PersistedData;

interface State extends PersistedData {
  setProfile: (p: Profile) => void;
  updateProfile: (patch: Partial<Profile>) => void;
  setLanguage: (l: LanguagePref) => void;
  addEntry: (e: Omit<DiaryEntry, 'id' | 'createdAt'>) => void;
  updateEntry: (id: string, patch: Partial<Pick<DiaryEntry, 'grams' | 'meal' | 'date'>>) => void;
  removeEntry: (id: string) => void;
  copyMeal: (fromDate: string, toDate: string, meal: MealType) => number;
  saveCustomFood: (f: Food) => void;
  removeCustomFood: (id: string) => void;
  addWater: (date: string, ml: number) => void;
  logWeight: (date: string, kg: number) => void;
  removeWeight: (date: string) => void;
  startFast: (s: Omit<FastingSession, 'id'>) => void;
  updateActiveFast: (patch: Partial<FastingSession>) => void;
  endFast: (end: number) => void;
  removeFast: (id: string) => void;
  setAI: (patch: Partial<AISettings>) => void;
  setProviderConfig: (id: AIProviderId, patch: Partial<AIProviderConfig>) => void;
  resetAll: () => void;
  /** Replaces all data with a backup (see backup.ts). */
  importBackup: (b: Backup) => void;
}

const initial: PersistedData = {
  profile: null,
  language: 'system' as LanguagePref,
  entries: [],
  customFoods: [],
  recentFoods: [],
  water: {},
  weights: [],
  fastingActive: null,
  fastingHistory: [],
  ai: DEFAULT_AI_SETTINGS,
};

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      ...initial,

      setProfile: (p) => set({ profile: p }),
      updateProfile: (patch) => set((s) => (s.profile ? { profile: { ...s.profile, ...patch } } : {})),
      setLanguage: (language) => set({ language }),

      addEntry: (e) =>
        set((s) => {
          const entry: DiaryEntry = { ...e, id: newId(), createdAt: Date.now() };
          const recent =
            e.food.source === 'quick'
              ? s.recentFoods
              : [e.food, ...s.recentFoods.filter((f) => f.id !== e.food.id)].slice(0, MAX_RECENT);
          return { entries: [...s.entries, entry], recentFoods: recent };
        }),
      updateEntry: (id, patch) => set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
      removeEntry: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),
      copyMeal: (fromDate, toDate, meal) => {
        const source = get().entries.filter((e) => e.date === fromDate && e.meal === meal);
        const now = Date.now();
        const copies = source.map((e, i) => ({ ...e, id: newId(), date: toDate, createdAt: now + i }));
        set((s) => ({ entries: [...s.entries, ...copies] }));
        return copies.length;
      },

      saveCustomFood: (f) => set((s) => ({ customFoods: [f, ...s.customFoods.filter((x) => x.id !== f.id)] })),
      removeCustomFood: (id) => set((s) => ({ customFoods: s.customFoods.filter((f) => f.id !== id) })),

      addWater: (date, ml) => set((s) => ({ water: { ...s.water, [date]: Math.max(0, (s.water[date] ?? 0) + ml) } })),

      logWeight: (date, kg) =>
        set((s) => ({
          weights: [...s.weights.filter((w) => w.date !== date), { date, kg }].sort((a, b) => a.date.localeCompare(b.date)),
        })),
      removeWeight: (date) => set((s) => ({ weights: s.weights.filter((w) => w.date !== date) })),

      startFast: (f) => set({ fastingActive: { ...f, id: newId() } }),
      updateActiveFast: (patch) => set((s) => (s.fastingActive ? { fastingActive: { ...s.fastingActive, ...patch } } : {})),
      endFast: (end) =>
        set((s) =>
          s.fastingActive
            ? { fastingActive: null, fastingHistory: [{ ...s.fastingActive, end }, ...s.fastingHistory].slice(0, 200) }
            : {},
        ),
      removeFast: (id) => set((s) => ({ fastingHistory: s.fastingHistory.filter((f) => f.id !== id) })),

      setAI: (patch) => set((s) => ({ ai: { ...s.ai, ...patch } })),
      setProviderConfig: (id, patch) =>
        set((s) => ({ ai: { ...s.ai, providers: { ...s.ai.providers, [id]: { ...s.ai.providers[id], ...patch } } } })),

      resetAll: () => set({ ...initial }),
      importBackup: (b) =>
        set((s) => ({
          ...initial,
          ...b,
          ai: { ...s.ai, ...b.ai, providers: { ...s.ai.providers, ...(b.ai?.providers ?? {}) } },
          // A fast running on the old phone would never notify here; start fresh.
          fastingActive: null,
        })),
    }),
    {
      // The key keeps its old name so existing data is found; the layout is versioned below.
      name: 'openplate-v1',
      version: STORE_VERSION,
      migrate: (persisted, version) => migrateState(persisted, version) as unknown as PersistedState,
      storage: createShardedStorage<PersistedState>(AsyncStorage),
      onRehydrateStorage: () => (_state, error) => {
        if (error) setHydrationError(error);
      },
      partialize: (s): PersistedState => ({
        profile: s.profile,
        language: s.language,
        entries: s.entries,
        customFoods: s.customFoods,
        recentFoods: s.recentFoods,
        water: s.water,
        weights: s.weights,
        fastingActive: s.fastingActive,
        fastingHistory: s.fastingHistory,
        ai: s.ai,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return {
          ...current,
          ...p,
          ai: {
            ...current.ai,
            ...(p.ai ?? {}),
            providers: { ...current.ai.providers, ...(p.ai?.providers ?? {}) },
          },
        };
      },
    },
  ),
);

/* ---------- Hydration status ---------- */

let hydrationError: unknown = null;
const errorListeners = new Set<() => void>();
function setHydrationError(e: unknown) {
  hydrationError = e;
  errorListeners.forEach((l) => l());
}

export type HydrationStatus = 'loading' | 'ready' | 'error';

/** 'error' when the stored data could not be read; the app then shows a message instead of a blank screen. */
export function useHydration(): { status: HydrationStatus; error: unknown; retry: () => void } {
  const read = (): HydrationStatus => (useStore.persist.hasHydrated() ? 'ready' : hydrationError ? 'error' : 'loading');
  const [status, setStatus] = useState<HydrationStatus>(read);
  useEffect(() => {
    const update = () => setStatus(read());
    const unsub = useStore.persist.onFinishHydration(update);
    errorListeners.add(update);
    update();
    return () => {
      unsub();
      errorListeners.delete(update);
    };
  }, []);
  const retry = () => {
    hydrationError = null;
    setStatus('loading');
    void useStore.persist.rehydrate();
  };
  return { status, error: hydrationError, retry };
}

export { weightOn } from './goals';
