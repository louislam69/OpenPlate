import { MAX_KCAL_PER_100G } from './ai';
import type { Food, Nutrients } from './types';

/**
 * Open Food Facts (https://world.openfoodfacts.org) — open database of packaged foods,
 * licensed under the Open Database License (ODbL). Attribution is shown in the app.
 */
const USER_AGENT = 'OpenPlate/1.0 (open-source calorie tracker; https://github.com/louislam69/OpenPlate)';
const FIELDS = [
  'code',
  'product_name',
  'product_name_de',
  'product_name_en',
  'generic_name',
  'brands',
  'nutriments',
  'serving_quantity',
  'serving_size',
  'quantity',
  'image_front_small_url',
].join(',');

type Json = Record<string, unknown>;

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown, lang: 'de' | 'en'): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(', ') || undefined;
  if (v && typeof v === 'object') {
    const o = v as Json;
    return str(o[lang], lang) ?? str(o.main, lang) ?? str(o.en, lang) ?? str(Object.values(o)[0], lang);
  }
  return undefined;
}

const plausibleKcal = (v: number | undefined): v is number => v !== undefined && v >= 0 && v <= MAX_KCAL_PER_100G;
/** Optional per-100 g values: negative or impossible ones are treated as unknown. */
const per100g = (v: number | undefined) => (v !== undefined && v >= 0 && v <= 100 ? v : undefined);

/**
 * Nutrients per 100 g from an Open Food Facts product. Community data contains typos (kJ typed
 * into the kcal field, misplaced decimal points); values that cannot be right are rejected, so the
 * product shows up as "not found" with the option to enter it correctly, instead of logging nonsense.
 */
export function nutrientsFromOFF(n: Json | undefined): Nutrients | undefined {
  if (!n) return undefined;
  const fromKj = (() => {
    const kj = num(n['energy-kj_100g']) ?? num(n['energy_100g']);
    return kj !== undefined ? kj / 4.184 : undefined;
  })();
  const kcalField = num(n['energy-kcal_100g']);
  const kcal = plausibleKcal(kcalField) ? kcalField : plausibleKcal(fromKj) ? fromKj : undefined;
  if (kcal === undefined) return undefined;
  const protein = per100g(num(n['proteins_100g']));
  const carbs = per100g(num(n['carbohydrates_100g']));
  const fat = per100g(num(n['fat_100g']));
  if ((protein ?? 0) + (carbs ?? 0) + (fat ?? 0) > 105) return undefined;
  return {
    kcal,
    protein: protein ?? 0,
    carbs: carbs ?? 0,
    fat: fat ?? 0,
    sugar: per100g(num(n['sugars_100g'])),
    fiber: per100g(num(n['fiber_100g'])),
    satFat: per100g(num(n['saturated-fat_100g'])),
    salt: per100g(num(n['salt_100g'])),
  };
}

export function foodFromOFF(p: Json, lang: 'de' | 'en'): Food | undefined {
  const per100 = nutrientsFromOFF(p.nutriments as Json | undefined);
  const code = str(p.code, lang);
  const name =
    str(p[`product_name_${lang}`], lang) ?? str(p.product_name, lang) ?? str(p.generic_name, lang) ?? str(p.product_name_en, lang);
  if (!per100 || !name) return undefined;
  const servingG = num(p.serving_quantity);
  const servingLabel = str(p.serving_size, lang);
  const quantity = str(p.quantity, lang) ?? '';
  const unit: 'g' | 'ml' = /\b\d+([.,]\d+)?\s*(ml|cl|l)\b/i.test(quantity) ? 'ml' : 'g';
  const brand = str(p.brands, lang)?.split(',')[0]?.trim();
  return {
    id: `off:${code ?? name}`,
    source: 'off',
    name,
    brand,
    barcode: code,
    per100,
    unit,
    servings: servingG && servingG > 0 ? [{ label: servingLabel ?? `${servingG} ${unit}`, grams: servingG }] : [],
    imageUrl: str(p.image_front_small_url, lang),
  };
}

export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** Thrown before a search would exceed Open Food Facts' rate limit. */
export class RateLimitedError extends Error {
  constructor() {
    super('RATE_LIMITED');
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function getJson(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 12000): Promise<Json> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as Json;
  } finally {
    clearTimeout(timer);
  }
}

/** EAN-8, UPC-A, EAN-13 or GTIN-14 typed into the search box. */
export const isBarcode = (q: string) => /^\d{8}$|^\d{12,14}$/.test(q.trim());

export async function lookupBarcode(code: string, lang: 'de' | 'en', fetchImpl: FetchLike = fetch): Promise<Food | null> {
  const clean = code.replace(/\D/g, '');
  if (clean.length < 8) return null;
  const data = await getJson(`https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=${FIELDS}`, fetchImpl);
  if (data.status !== 1 || !data.product) return null;
  const food = foodFromOFF({ code: clean, ...(data.product as Json) }, lang);
  return food ?? null;
}

/*
 * Open Food Facts allows 10 search requests per minute per IP and explicitly asks apps not to
 * search while the user types. The app therefore searches only when the user submits, keeps
 * results for a while, and stops itself before reaching the limit.
 */
const SEARCH_LIMIT = 8;
const SEARCH_WINDOW_MS = 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 50;
const recentSearches: number[] = [];
const searchCache = new Map<string, { at: number; foods: Food[] }>();

function takeSearchSlot(now: number) {
  while (recentSearches.length && now - recentSearches[0] > SEARCH_WINDOW_MS) recentSearches.shift();
  if (recentSearches.length >= SEARCH_LIMIT) throw new RateLimitedError();
  recentSearches.push(now);
}

/** For tests. */
export function _resetSearchState() {
  recentSearches.length = 0;
  searchCache.clear();
}

/**
 * Full-text search: tries the newer search service, and the classic endpoint only when the first
 * one could not be reached (never after a rate-limit answer, which would just double the load).
 */
export async function searchOFF(query: string, lang: 'de' | 'en', pageSize = 25, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<Food[]> {
  const trimmed = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const q = encodeURIComponent(trimmed);
  if (!q) return [];
  const cacheKey = `${lang}:${trimmed}`;
  const cached = searchCache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.foods;

  takeSearchSlot(now);
  let hits: Json[] = [];
  try {
    const data = await getJson(`https://search.openfoodfacts.org/search?q=${q}&page_size=${pageSize}&langs=${lang},en&fields=${FIELDS}`, fetchImpl);
    hits = Array.isArray(data.hits) ? (data.hits as Json[]) : [];
  } catch (e) {
    if (e instanceof HttpError && (e.status === 429 || e.status < 500)) throw e;
    takeSearchSlot(now);
    const data = await getJson(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=${pageSize}&fields=${FIELDS}`,
      fetchImpl,
    );
    hits = Array.isArray(data.products) ? (data.products as Json[]) : [];
  }
  const seen = new Set<string>();
  const out: Food[] = [];
  for (const h of hits) {
    const f = foodFromOFF(h, lang);
    if (f && !seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
    }
  }
  if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(cacheKey, { at: now, foods: out });
  return out;
}
