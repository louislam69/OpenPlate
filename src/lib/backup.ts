import { migrateState } from './migrations';
import { MEALS, type AISettings, type DiaryEntry, type FastingSession, type Food, type PersistedData, type Profile, type WeightEntry } from './types';

/**
 * Backup file format. Exports from older versions (without `format`) can be imported too.
 * API keys are never part of a backup.
 */
export const BACKUP_FORMAT = 2;

export interface Backup {
  profile: Profile | null;
  language: PersistedData['language'];
  entries: DiaryEntry[];
  customFoods: Food[];
  recentFoods: Food[];
  water: Record<string, number>;
  weights: WeightEntry[];
  fastingHistory: FastingSession[];
  ai?: Partial<AISettings>;
}

export function makeBackup(d: PersistedData, now = new Date()) {
  return {
    app: 'OpenPlate',
    format: BACKUP_FORMAT,
    exportedAt: now.toISOString(),
    profile: d.profile,
    language: d.language,
    entries: d.entries,
    customFoods: d.customFoods,
    recentFoods: d.recentFoods,
    water: d.water,
    weights: d.weights,
    fastingHistory: d.fastingHistory,
    ai: d.ai,
  };
}

export class BackupError extends Error {
  constructor(public code: 'not_json' | 'not_openplate' | 'invalid') {
    super(code);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function validFood(f: unknown): f is Food {
  return (
    isObj(f) &&
    typeof f.id === 'string' &&
    typeof f.name === 'string' &&
    typeof f.source === 'string' &&
    isObj(f.per100) &&
    isNum(f.per100.kcal) &&
    isNum(f.per100.protein) &&
    isNum(f.per100.carbs) &&
    isNum(f.per100.fat) &&
    Array.isArray(f.servings)
  );
}

function validEntry(e: unknown): e is DiaryEntry {
  return (
    isObj(e) &&
    typeof e.id === 'string' &&
    isDay(e.date) &&
    MEALS.includes(e.meal as DiaryEntry['meal']) &&
    isNum(e.grams) &&
    e.grams > 0 &&
    isNum(e.createdAt) &&
    validFood(e.food)
  );
}

function validProfile(p: unknown): p is Profile {
  return (
    isObj(p) &&
    (p.sex === 'female' || p.sex === 'male') &&
    isNum(p.birthYear) &&
    isNum(p.heightCm) &&
    isNum(p.startWeightKg) &&
    isNum(p.targetWeightKg) &&
    typeof p.activity === 'string' &&
    typeof p.goal === 'string' &&
    isNum(p.paceKgPerWeek) &&
    isObj(p.macroSplit) &&
    isNum(p.waterGoalMl) &&
    isNum(p.glassMl) &&
    isNum(p.stepGoal) &&
    typeof p.fastingPlanId === 'string' &&
    Array.isArray(p.fastingDays)
  );
}

const list = <T>(v: unknown, ok: (x: unknown) => x is T): { items: T[]; skipped: number } => {
  if (v === undefined) return { items: [], skipped: 0 };
  if (!Array.isArray(v)) throw new BackupError('invalid');
  const items = v.filter(ok);
  return { items, skipped: v.length - items.length };
};

/** Reads a backup file. Throws BackupError when it is not a usable OpenPlate backup;
 * single damaged records are skipped and counted. */
export function parseBackup(text: string): { backup: Backup; skipped: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('not_json');
  }
  if (!isObj(data) || data.app !== 'OpenPlate') throw new BackupError('not_openplate');
  if (data.profile !== null && data.profile !== undefined && !validProfile(data.profile)) throw new BackupError('invalid');

  const entries = list(data.entries, validEntry);
  const customFoods = list(data.customFoods, validFood);
  const recentFoods = list(data.recentFoods, validFood);
  const weights = list(data.weights, (w): w is WeightEntry => isObj(w) && isDay(w.date) && isNum(w.kg) && w.kg > 0);
  const fasts = list(data.fastingHistory, (f): f is FastingSession => isObj(f) && typeof f.id === 'string' && isNum(f.start) && isNum(f.targetHours));

  const water: Record<string, number> = {};
  if (isObj(data.water)) for (const [k, v] of Object.entries(data.water)) if (isDay(k) && isNum(v) && v >= 0) water[k] = v;

  const language = data.language === 'de' || data.language === 'en' ? data.language : 'system';
  const backup: Backup = {
    profile: (data.profile as Profile | undefined) ?? null,
    language,
    entries: entries.items,
    customFoods: customFoods.items,
    recentFoods: recentFoods.items,
    water,
    weights: weights.items.sort((a, b) => a.date.localeCompare(b.date)),
    fastingHistory: fasts.items,
    ai: isObj(data.ai) ? (data.ai as Partial<AISettings>) : undefined,
  };
  const skipped = entries.skipped + customFoods.skipped + recentFoods.skipped + weights.skipped + fasts.skipped;
  // Older exports carry the old settings layout; bring them up to date like stored data.
  const fromVersion = isNum(data.format) ? data.format : 1;
  return { backup: migrateState(backup, fromVersion) as unknown as Backup, skipped };
}
