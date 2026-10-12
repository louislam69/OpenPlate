// Logic tests for the platform-independent modules (no React Native needed).
// Run: npx tsc -p tests/tsconfig.json && node --test .test-build/tests/logic.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeMeal,
  buildMealPrompt,
  callProvider,
  CANCELLED,
  isPrivateHost,
  parseMealJson,
  providerOrder,
  serverUrlProblem,
  DEFAULT_AI_SETTINGS,
} from '../src/lib/ai';
import { BackupError, makeBackup, parseBackup } from '../src/lib/backup';
import { addDays, dayKey, lastNDays, weekdayOf } from '../src/lib/dates';
import { activeFastingDays, isFastingDay, stageFor } from '../src/lib/fasting';
import { searchGeneric, genericFoods } from '../src/lib/genericFoods';
import { goalsFor } from '../src/lib/goals';
import { ALL_KEYS, _dicts, translate } from '../src/lib/i18n';
import { migrateState, OLD_LOCAL_DEFAULT_URL } from '../src/lib/migrations';
import {
  bmr,
  dailyKcalGoal,
  goalStatus,
  isAdult,
  macroGrams,
  minHealthyWeight,
  per100From,
  scaleNutrients,
  sumEntries,
  defaultWaterGoal,
  tdee,
} from '../src/lib/nutrition';
import { _resetSearchState, foodFromOFF, HttpError, isBarcode, RateLimitedError, searchOFF } from '../src/lib/openFoodFacts';
import { createShardedStorage, memoryStore } from '../src/lib/persistStorage';
import type { AISettings, DiaryEntry, PersistedData, Profile, ProfileDraft } from '../src/lib/types';
import { draftProblem } from '../src/lib/validation';

const profile: Profile = {
  sex: 'female',
  birthYear: 1996,
  heightCm: 168,
  startWeightKg: 72,
  targetWeightKg: 65,
  activity: 'light',
  goal: 'lose',
  paceKgPerWeek: 0.5,
  macroSplit: { carbs: 50, protein: 20, fat: 30 },
  waterGoalMl: 2500,
  glassMl: 250,
  stepGoal: 10000,
  addActivityCalories: false,
  fastingPlanId: '5:2',
  fastingDays: [1, 4],
  createdAt: 0,
};
const now = new Date(2026, 9, 12);

test('BMR follows Mifflin-St Jeor', () => {
  // 10*72 + 6.25*168 - 5*30 - 161 = 720 + 1050 - 150 - 161 = 1459
  assert.equal(Math.round(bmr(profile, 72, now)), 1459);
  assert.equal(Math.round(bmr({ ...profile, sex: 'male' }, 72, now)), 1625);
});

test('daily goal: deficit, floor and gain', () => {
  // TDEE 1459*1.375 = 2006; minus 550 = 1456 -> 1460
  assert.equal(dailyKcalGoal(profile, 72, now), 1460);
  assert.equal(dailyKcalGoal({ ...profile, paceKgPerWeek: 1 }, 72, now), 1200);
  assert.equal(dailyKcalGoal({ ...profile, goal: 'maintain', paceKgPerWeek: 0 }, 72, now), 2010);
  assert.ok(dailyKcalGoal({ ...profile, goal: 'gain', targetWeightKg: 80 }, 72, now) > 2010);
});

test('macro grams from split', () => {
  assert.deepEqual(macroGrams(2000, { carbs: 50, protein: 20, fat: 30 }), { carbs: 250, protein: 100, fat: 67 });
});

test('scaling and per-100 conversion are inverse', () => {
  const portion = { kcal: 640, protein: 32, carbs: 80, fat: 20 };
  const p100 = per100From(portion, 400);
  assert.deepEqual(p100, { kcal: 160, protein: 8, carbs: 20, fat: 5 });
  const back = scaleNutrients(p100, 400);
  assert.equal(back.kcal, 640);
});

test('sumEntries adds diary entries', () => {
  const food = genericFoods('en').find((f) => f.id === 'generic:banana')!;
  const total = sumEntries([
    { id: '1', date: '2026-10-12', meal: 'breakfast', food, grams: 120, createdAt: 0 },
    { id: '2', date: '2026-10-12', meal: 'snack', food, grams: 100, createdAt: 0 },
  ]);
  assert.equal(Math.round(total.kcal), Math.round(89 * 2.2));
});

test('water goal is bounded', () => {
  assert.equal(defaultWaterGoal(72), 2500);
  assert.equal(defaultWaterGoal(30), 1500);
  assert.equal(defaultWaterGoal(200), 4000);
});

test('dates', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-10-12'), 1); // Monday
  assert.deepEqual(lastNDays('2026-10-12', 3), ['2026-10-10', '2026-10-11', '2026-10-12']);
  assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('fasting days and stages', () => {
  assert.equal(isFastingDay(profile, '2026-10-12'), true); // Monday
  assert.equal(isFastingDay(profile, '2026-10-13'), false);
  assert.equal(isFastingDay({ ...profile, fastingPlanId: '16:8' }, '2026-10-12'), false);
  assert.equal(stageFor(0).key, 'stage_digest');
  assert.equal(stageFor(13).key, 'stage_switch');
  assert.equal(stageFor(30).key, 'stage_deep');
});

test('generic search finds both languages and umlauts', () => {
  assert.equal(searchGeneric('apfel', 'de')[0].name, 'Apfel');
  assert.equal(searchGeneric('apple', 'de')[0].name, 'Apfel');
  assert.ok(searchGeneric('brotchen', 'de').some((f) => f.name === 'Brötchen'));
  assert.ok(searchGeneric('dö', 'de').some((f) => f.name === 'Döner'));
  assert.equal(searchGeneric('', 'de').length, 0);
  const ids = genericFoods('en').map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate generic ids');
  for (const f of genericFoods('en')) {
    const { kcal, protein, carbs, fat } = f.per100;
    const fromMacros = protein * 4 + carbs * 4 + fat * 9;
    // alcohol, fibre and rounding aside, energy should roughly match macros (low-calorie vegetables skew)
    if (!['generic:beer', 'generic:red_wine'].includes(f.id) && kcal > 60) {
      assert.ok(Math.abs(fromMacros - kcal) / kcal < 0.25, `${f.id}: ${kcal} kcal vs ${fromMacros.toFixed(0)} from macros`);
    }
  }
});

test('translations: German has every key and placeholders match', () => {
  for (const key of ALL_KEYS) {
    const en = _dicts.en[key];
    const de = _dicts.de[key];
    assert.ok(de && de.trim(), `missing de: ${key}`);
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    assert.equal(ph(de), ph(en), `placeholder mismatch: ${key}`);
  }
  assert.equal(translate('de', 'fasting_mini', { elapsed: '1:00:00', target: 16 }), '1:00:00 von 16 h');
});

test('Open Food Facts mapping', () => {
  const f = foodFromOFF(
    {
      code: '4000000000001',
      product_name: 'Skyr Natur',
      brands: 'Musterhof, Other',
      quantity: '450 g',
      serving_quantity: '150',
      serving_size: '150 g',
      nutriments: { 'energy-kcal_100g': 63, proteins_100g: '11', carbohydrates_100g: 4, fat_100g: 0.2, salt_100g: 0.1 },
    },
    'de',
  )!;
  assert.equal(f.name, 'Skyr Natur');
  assert.equal(f.brand, 'Musterhof');
  assert.equal(f.per100.protein, 11);
  assert.equal(f.unit, 'g');
  assert.deepEqual(f.servings, [{ label: '150 g', grams: 150 }]);
  const drink = foodFromOFF(
    { code: '1', product_name: { de: 'Apfelschorle', en: 'Apple spritzer' }, quantity: '1 l', nutriments: { 'energy-kj_100g': 100 } },
    'de',
  )!;
  assert.equal(drink.name, 'Apfelschorle');
  assert.equal(drink.unit, 'ml');
  assert.equal(Math.round(drink.per100.kcal), 24);
  assert.equal(foodFromOFF({ code: '2', product_name: 'No data' }, 'de'), undefined);
});

test('AI JSON parsing is tolerant', () => {
  const r = parseMealJson(
    'Here you go:\n```json\n{"items":[{"name":"Pasta","grams":"250","kcal":395,"protein":14.5,"carbs":77,"fat":2.3,"confidence":0.8},{"name":"","grams":10,"kcal":5}],"confidence":0.75,"notes":"ok"}\n```',
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 250);
  assert.equal(r.confidence, 0.75);
  const noOverall = parseMealJson('{"items":[{"name":"Apfel","grams":180,"kcal":94,"confidence":0.9}]}');
  assert.equal(noOverall.items[0].protein, 0);
  assert.equal(noOverall.confidence, 0.9);
  assert.throws(() => parseMealJson('sorry, I cannot help'));
  assert.ok(buildMealPrompt('de', 'mit Öl').includes('German'));
  assert.ok(buildMealPrompt('de', 'mit Öl').includes('mit Öl'));
});

const settings = (primary: AISettings['primary'], fallback: AISettings['fallback']): AISettings => ({
  ...DEFAULT_AI_SETTINGS,
  primary,
  fallback,
});
const reply = (conf: number, n = 1) =>
  JSON.stringify({ items: Array.from({ length: n }, () => ({ name: 'X', grams: 100, kcal: 100, confidence: conf })), confidence: conf });

test('fallback: confident primary is used alone', async () => {
  const calls: string[] = [];
  const out = await analyzeMeal('b64', settings('gemini', 'local'), async () => 'k', 'en', undefined, async (r) => {
    calls.push(r.provider);
    return reply(0.9);
  });
  assert.deepEqual(calls, ['gemini']);
  assert.equal(out.usedFallback, false);
});

test('fallback: unsure primary asks fallback and keeps better answer', async () => {
  const out = await analyzeMeal('b64', settings('local', 'anthropic'), async () => 'k', 'en', undefined, async (r) =>
    r.provider === 'local' ? reply(0.3) : reply(0.85, 2),
  );
  assert.equal(out.result.provider, 'anthropic');
  assert.equal(out.usedFallback, true);
  assert.equal(out.attempts.length, 2);
});

test('fallback: failing primary falls back; both failing throws', async () => {
  const out = await analyzeMeal('b64', settings('openai', 'gemini'), async () => 'k', 'en', undefined, async (r) => {
    if (r.provider === 'openai') throw new Error('HTTP 401');
    return reply(0.6);
  });
  assert.equal(out.result.provider, 'gemini');
  await assert.rejects(
    analyzeMeal('b64', settings('openai', 'gemini'), async () => 'k', 'en', undefined, async () => {
      throw new Error('down');
    }),
    /down/,
  );
  await assert.rejects(analyzeMeal('b64', settings(null, null), async () => null, 'en'), /NO_PROVIDER/);
  assert.deepEqual(providerOrder(settings('gemini', 'gemini')), ['gemini']);
});

test('provider requests are shaped correctly', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fake = (body: unknown) => async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const base = { prompt: 'p', imageBase64: 'AAA' };
  const a = await callProvider({ ...base, provider: 'anthropic', config: { model: 'm' }, apiKey: 'sk' }, fake({ content: [{ type: 'text', text: 'A' }] }));
  assert.equal(a, 'A');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal((seen[0].init.headers as Record<string, string>)['x-api-key'], 'sk');
  const g = await callProvider(
    { ...base, provider: 'gemini', config: { model: 'gemini-x' }, apiKey: 'gk' },
    fake({ candidates: [{ content: { parts: [{ text: 'G' }] } }] }),
  );
  assert.equal(g, 'G');
  assert.ok(seen[1].url.endsWith('/models/gemini-x:generateContent'));
  const l = await callProvider(
    { ...base, provider: 'local', config: { model: 'llava', baseUrl: 'http://10.0.0.2:11434/v1/' }, apiKey: null },
    fake({ choices: [{ message: { content: 'L' } }] }),
  );
  assert.equal(l, 'L');
  assert.equal(seen[2].url, 'http://10.0.0.2:11434/v1/chat/completions');
  const body = JSON.parse(String(seen[2].init.body));
  assert.equal(body.response_format, undefined);
  assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAA');
  await assert.rejects(callProvider({ ...base, provider: 'openai', config: { model: 'm' }, apiKey: null }), /No API key/);
  const err = async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
  await assert.rejects(callProvider({ ...base, provider: 'openai', config: { model: 'm' }, apiKey: 'x' }, err), /HTTP 401: invalid key/);
});

/* ---------- Goals and safety limits ---------- */

test('weight-loss goal never exceeds maintenance, even under the calorie floor', () => {
  // Small, older, sedentary woman: maintenance is below the 1200 kcal floor.
  const small: Profile = { ...profile, birthYear: 1946, heightCm: 150, startWeightKg: 50, targetWeightKg: 46, activity: 'sedentary' };
  const maintenance = tdee(small, 50, now);
  assert.ok(maintenance < 1200, `test setup: maintenance ${maintenance}`);
  const goal = dailyKcalGoal(small, 50, now);
  assert.ok(goal <= Math.round(maintenance / 10) * 10, `goal ${goal} above maintenance ${maintenance}`);
});

test('reaching the target switches to maintenance', () => {
  const maintain = dailyKcalGoal({ ...profile, goal: 'maintain' }, 65, now);
  assert.equal(goalStatus(profile, 65, now), 'reached');
  assert.equal(dailyKcalGoal(profile, 65, now), maintain);
  assert.equal(dailyKcalGoal(profile, 64, now), dailyKcalGoal({ ...profile, goal: 'maintain' }, 64, now));
  const gainer: Profile = { ...profile, goal: 'gain', targetWeightKg: 75 };
  assert.equal(goalStatus(gainer, 75, now), 'reached');
  assert.equal(dailyKcalGoal(gainer, 76, now), dailyKcalGoal({ ...gainer, goal: 'maintain' }, 76, now));
  assert.equal(goalStatus(gainer, 74, now), 'active');
});

test('minors and underweight users get no deficit', () => {
  const teen: Profile = { ...profile, birthYear: 2011 };
  assert.equal(isAdult(2011, now), false);
  assert.equal(isAdult(2008, now), true);
  assert.equal(goalStatus(teen, 72, now), 'minor');
  assert.equal(dailyKcalGoal(teen, 72, now), dailyKcalGoal({ ...teen, goal: 'maintain' }, 72, now));
  // 168 cm, 50 kg -> BMI 17.7
  assert.equal(goalStatus({ ...profile, targetWeightKg: 45 }, 50, now), 'underweight');
  // no fasting days for minors either
  assert.equal(isFastingDay(teen, '2026-10-12', now), false);
  const g = goalsFor(teen, [], '2026-10-12', now);
  assert.equal(g.fastDay, false);
  assert.equal(g.status, 'minor');
});

test('profile validation: age, healthy target, ranges', () => {
  const draft: ProfileDraft = {
    goal: 'lose',
    sex: 'female',
    birthYear: 1996,
    heightCm: 170,
    startWeightKg: 75,
    targetWeightKg: 68,
    activity: 'light',
    paceKgPerWeek: 0.5,
  };
  assert.equal(draftProblem(draft, now), null);
  assert.equal(draftProblem({ ...draft, birthYear: 2011 }, now)?.key, 'err_minor_lose');
  assert.equal(draftProblem({ ...draft, birthYear: 2011, goal: 'maintain' }, now), null);
  assert.equal(minHealthyWeight(170), 53.5);
  assert.deepEqual(draftProblem({ ...draft, targetWeightKg: 50 }, now), { key: 'err_target_bmi', params: { kg: 53.5 } });
  assert.equal(draftProblem({ ...draft, targetWeightKg: 53.5 }, now), null);
  assert.equal(draftProblem({ ...draft, startWeightKg: 50, targetWeightKg: 48 }, now)?.key, 'err_underweight_lose');
  assert.equal(draftProblem({ ...draft, startWeightKg: 34 }, now)?.key, 'err_weight');
  assert.equal(draftProblem({ ...draft, targetWeightKg: 80 }, now)?.key, 'err_target_lose');
  assert.equal(draftProblem({ ...draft, goal: 'gain', targetWeightKg: 70 }, now)?.key, 'err_target_gain');
});

test('6:1 keeps a single fasting day, also with two stored', () => {
  const sixOne = { ...profile, fastingPlanId: '6:1', fastingDays: [1, 4] };
  assert.deepEqual(activeFastingDays(sixOne), [4]);
  assert.equal(isFastingDay(sixOne, '2026-10-12', now), false); // Monday no longer counts
  assert.equal(isFastingDay(sixOne, '2026-10-15', now), true); // Thursday
  assert.deepEqual(activeFastingDays({ ...profile, fastingDays: [1, 1, 4] }), [1, 4]);
  assert.deepEqual(activeFastingDays({ ...profile, fastingPlanId: '16:8' }), []);
});

/* ---------- AI and network ---------- */

test('server addresses: http only on the local network', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.178.20', '172.16.0.1', '172.31.255.1', 'pc.local', 'nas.lan', '100.101.102.103', '[::1]', '[fd12::1]']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', '100.128.0.1', 'local.example.com']) {
    assert.equal(isPrivateHost(h), false, h);
  }
  assert.equal(serverUrlProblem(''), 'empty');
  assert.equal(serverUrlProblem('192.168.1.2:11434'), 'invalid');
  assert.equal(serverUrlProblem('ftp://pc.local/v1'), 'invalid');
  assert.equal(serverUrlProblem('http://192.168.1.2:11434/v1'), null);
  assert.equal(serverUrlProblem('https://api.example.com/v1'), null);
  assert.equal(serverUrlProblem('http://api.example.com/v1'), 'insecure');
  assert.equal(DEFAULT_AI_SETTINGS.providers.local.baseUrl, '');
});

test('API keys are never sent over public http', async () => {
  let called = false;
  const fake = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  await assert.rejects(
    callProvider({ provider: 'openai', config: { model: 'm', baseUrl: 'http://proxy.example.com/v1' }, apiKey: 'sk', prompt: 'p' }, fake),
    /plain http/,
  );
  await assert.rejects(callProvider({ provider: 'local', config: { model: 'm', baseUrl: '' }, apiKey: null, prompt: 'p' }, fake), /No server address/);
  assert.equal(called, false);
  // empty OpenAI address falls back to the official https endpoint
  const seen: string[] = [];
  await callProvider({ provider: 'openai', config: { model: 'm', baseUrl: '' }, apiKey: 'sk', prompt: 'p' }, async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  });
  assert.deepEqual(seen, ['https://api.openai.com/v1/chat/completions']);
});

test('cancelling an analysis stops without trying the fallback', async () => {
  const ctrl = new AbortController();
  const calls: string[] = [];
  const run = analyzeMeal('b64', settings('local', 'gemini'), async () => 'k', 'en', undefined, async (r) => {
    calls.push(r.provider);
    ctrl.abort();
    throw new Error('aborted');
  }, ctrl.signal);
  await assert.rejects(run, new RegExp(CANCELLED));
  assert.deepEqual(calls, ['local']);
});

test('implausible AI values are dropped or flagged', () => {
  const r = parseMealJson(
    JSON.stringify({
      items: [
        { name: 'Huge', grams: 9000, kcal: 9000, confidence: 0.9 },
        { name: 'Impossible', grams: 100, kcal: 2000, confidence: 0.9 },
        { name: 'Heavy macros', grams: 100, kcal: 300, protein: 100, carbs: 100, fat: 0, confidence: 0.9 },
        { name: 'Too few kcal', grams: 200, kcal: 50, protein: 20, carbs: 60, fat: 20, confidence: 0.9 },
        { name: 'Beer', grams: 500, kcal: 215, protein: 2.5, carbs: 18, fat: 0, confidence: 0.9 },
      ],
      confidence: 0.9,
    }),
  );
  assert.deepEqual(r.items.map((i) => i.name), ['Too few kcal', 'Beer']);
  assert.equal(r.items[0].kcal, 20 * 4 + 60 * 4 + 20 * 9);
  assert.equal(r.items[0].confidence, 0.3);
  assert.equal(r.items[1].kcal, 215); // alcohol: more kcal than macros is fine
  assert.equal(r.confidence, 0.3); // overall drops so the fallback is asked
});

test('implausible Open Food Facts values are rejected', () => {
  const base = { code: '3', product_name: 'P' };
  // kJ typed into the kcal field, correct kJ available
  const fixed = foodFromOFF({ ...base, nutriments: { 'energy-kcal_100g': 1500, 'energy-kj_100g': 1500 } }, 'en')!;
  assert.equal(Math.round(fixed.per100.kcal), 359);
  assert.equal(foodFromOFF({ ...base, nutriments: { 'energy-kcal_100g': 2500 } }, 'en'), undefined);
  assert.equal(foodFromOFF({ ...base, nutriments: { 'energy-kcal_100g': 300, proteins_100g: 80, carbohydrates_100g: 80 } }, 'en'), undefined);
  const neg = foodFromOFF({ ...base, nutriments: { 'energy-kcal_100g': 100, fat_100g: -3, sugars_100g: 400 } }, 'en')!;
  assert.equal(neg.per100.fat, 0);
  assert.equal(neg.per100.sugar, undefined);
});

test('product search: cached, rate-limited, no fallback after 429', async () => {
  _resetSearchState();
  const urls: string[] = [];
  const ok = async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ hits: [{ code: '1', product_name: 'Milk', nutriments: { 'energy-kcal_100g': 64 } }] }), { status: 200 });
  };
  const t0 = 1_000_000;
  const first = await searchOFF('Milk', 'en', 25, ok, t0);
  assert.equal(first.length, 1);
  await searchOFF(' milk ', 'en', 25, ok, t0 + 1000);
  assert.equal(urls.length, 1, 'second identical search should come from the cache');
  for (let i = 0; i < 7; i++) await searchOFF(`q${i}`, 'en', 25, ok, t0 + 2000);
  await assert.rejects(searchOFF('one too many', 'en', 25, ok, t0 + 3000), RateLimitedError);
  await searchOFF('later', 'en', 25, ok, t0 + 70_000);

  _resetSearchState();
  const limited: string[] = [];
  await assert.rejects(
    searchOFF('x', 'en', 25, async (url) => {
      limited.push(url);
      return new Response('', { status: 429 });
    }, t0),
    (e: unknown) => e instanceof HttpError && e.status === 429,
  );
  assert.equal(limited.length, 1, 'a 429 must not trigger the second endpoint');

  _resetSearchState();
  const down: string[] = [];
  const res = await searchOFF('y', 'en', 25, async (url) => {
    down.push(url);
    if (url.includes('search.openfoodfacts.org')) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ products: [] }), { status: 200 });
  }, t0);
  assert.deepEqual(res, []);
  assert.equal(down.length, 2);
  assert.equal(isBarcode('4000417025005'), true);
  assert.equal(isBarcode('12345'), false);
  assert.equal(isBarcode('milk 1'), false);
});

/* ---------- Storage, migration, backup ---------- */

const entry = (id: string, date: string): DiaryEntry => ({
  id,
  date,
  meal: 'lunch',
  grams: 100,
  createdAt: 1,
  food: { id: 'f', source: 'custom', name: 'Food', per100: { kcal: 100, protein: 1, carbs: 1, fat: 1 }, servings: [] },
});

test('storage splits entries by month and writes only what changed', async () => {
  type S = { entries: DiaryEntry[]; water: Record<string, number> };
  // Legacy layout: everything in one value.
  const legacy = { state: { entries: [entry('a', '2026-09-30'), entry('b', '2026-10-01')], water: { '2026-10-01': 500 } }, version: 1 };
  const kv = memoryStore({ app: JSON.stringify(legacy) });
  const storage = createShardedStorage<S>(kv);

  const loaded = await storage.getItem('app');
  assert.deepEqual(loaded?.state.entries.map((e) => e.id), ['a', 'b']);
  assert.equal(loaded?.version, 1);

  await storage.setItem('app', { state: loaded!.state, version: 2 });
  assert.deepEqual([...kv.data.keys()].sort(), ['app', 'app:entries:2026-09', 'app:entries:2026-10']);
  assert.equal(JSON.parse(kv.data.get('app')!).state.entries, undefined);

  // Adding an October entry rewrites October only.
  let writes: string[] = [];
  const spy = { ...kv, multiSet: async (pairs: [string, string][]) => { writes = pairs.map(([k]) => k); await kv.multiSet(pairs); } };
  const storage2 = createShardedStorage<S>(spy);
  const s2 = (await storage2.getItem('app'))!;
  await storage2.setItem('app', { state: { ...s2.state, entries: [...s2.state.entries, entry('c', '2026-10-12')] }, version: 2 });
  assert.deepEqual(writes, ['app:entries:2026-10']);

  // Removing the only September entry removes that value.
  await storage2.setItem('app', { state: { ...s2.state, entries: [entry('b', '2026-10-01')] }, version: 2 });
  assert.equal(kv.data.has('app:entries:2026-09'), false);

  // A fresh reader sees exactly the stored entries (legacy copy ignored once months exist).
  const reread = await createShardedStorage<S>(kv).getItem('app');
  assert.deepEqual(reread?.state.entries.map((e) => e.id), ['b']);
  assert.deepEqual(reread?.state.water, { '2026-10-01': 500 });
});

test('storage never writes before a successful read', async () => {
  const kv = memoryStore({ app: '{not json' });
  const storage = createShardedStorage<{ entries: DiaryEntry[] }>(kv);
  await assert.rejects(storage.getItem('app'));
  await storage.setItem('app', { state: { entries: [] }, version: 2 });
  assert.equal(kv.data.get('app'), '{not json', 'unreadable data must not be overwritten');
});

test('migration clears the old hard-coded local server address', () => {
  const v1 = (primary: AISettings['primary']) => ({
    ai: { ...DEFAULT_AI_SETTINGS, primary, providers: { ...DEFAULT_AI_SETTINGS.providers, local: { model: 'm', baseUrl: OLD_LOCAL_DEFAULT_URL } } },
  });
  assert.equal((migrateState(v1('gemini'), 1).ai as AISettings).providers.local.baseUrl, '');
  assert.equal((migrateState(v1('local'), 1).ai as AISettings).providers.local.baseUrl, OLD_LOCAL_DEFAULT_URL);
  assert.equal((migrateState(v1('gemini'), 2).ai as AISettings).providers.local.baseUrl, OLD_LOCAL_DEFAULT_URL);
});

test('backup round trip, old exports, damaged files', () => {
  const data: PersistedData = {
    profile,
    language: 'de',
    entries: [entry('a', '2026-10-01')],
    customFoods: [],
    recentFoods: [],
    water: { '2026-10-01': 750 },
    weights: [{ date: '2026-10-01', kg: 71 }],
    fastingActive: null,
    fastingHistory: [{ id: 'f1', start: 1, end: 2, targetHours: 16, planId: '16:8' }],
    ai: DEFAULT_AI_SETTINGS,
  };
  const { backup, skipped } = parseBackup(JSON.stringify(makeBackup(data, now)));
  assert.equal(skipped, 0);
  assert.deepEqual(backup.entries, data.entries);
  assert.deepEqual(backup.water, data.water);
  assert.equal(backup.language, 'de');

  // Export from version 1 (no format, no recentFoods), one broken entry
  const old = { app: 'OpenPlate', exportedAt: 'x', profile, entries: [entry('a', '2026-10-01'), { id: 'bad' }], water: {}, weights: [], fastingHistory: [] };
  const parsed = parseBackup(JSON.stringify(old));
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.backup.recentFoods, []);

  assert.throws(() => parseBackup('nope'), (e: unknown) => e instanceof BackupError && e.code === 'not_json');
  assert.throws(() => parseBackup('{"app":"Other"}'), (e: unknown) => e instanceof BackupError && e.code === 'not_openplate');
  assert.throws(() => parseBackup('{"app":"OpenPlate","entries":5}'), (e: unknown) => e instanceof BackupError && e.code === 'invalid');
  assert.throws(() => parseBackup('{"app":"OpenPlate","profile":{"sex":"x"}}'), (e: unknown) => e instanceof BackupError && e.code === 'invalid');
});

test('goals use each day’s own weight', () => {
  const weights = [
    { date: '2026-10-01', kg: 70 },
    { date: '2026-10-10', kg: 64 },
  ];
  assert.equal(goalsFor(profile, weights, '2026-09-30', now).weight, 72);
  assert.equal(goalsFor(profile, weights, '2026-10-05', now).weight, 70);
  assert.equal(goalsFor(profile, weights, '2026-10-11', now).status, 'reached');
});
