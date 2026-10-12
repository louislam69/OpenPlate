import type { TKey } from './i18n';
import { bmi, isAdult, MAX_WEIGHT_KG, MIN_TARGET_BMI, minHealthyWeight, validWeight } from './nutrition';
import type { ProfileDraft } from './types';

export interface Problem {
  key: TKey;
  params?: Record<string, string | number>;
}

/** First problem with a profile draft, or null when it can be saved. */
export function draftProblem(d: ProfileDraft, now = new Date()): Problem | null {
  const year = now.getFullYear();
  if (!d.birthYear || d.birthYear < year - 100 || d.birthYear > year - 13) return { key: 'err_birth_year' };
  if (!d.heightCm || d.heightCm < 120 || d.heightCm > 230) return { key: 'err_height' };
  if (!validWeight(d.startWeightKg)) return { key: 'err_weight' };
  if (d.goal !== 'maintain' && !validWeight(d.targetWeightKg)) return { key: 'err_weight' };
  if (d.goal === 'lose') {
    if (!isAdult(d.birthYear, now)) return { key: 'err_minor_lose' };
    if (bmi(d.startWeightKg, d.heightCm) < MIN_TARGET_BMI) return { key: 'err_underweight_lose' };
    if (d.targetWeightKg! >= d.startWeightKg) return { key: 'err_target_lose' };
    const min = minHealthyWeight(d.heightCm);
    if (d.targetWeightKg! < min) return { key: 'err_target_bmi', params: { kg: min } };
  }
  if (d.goal === 'gain' && d.targetWeightKg! <= d.startWeightKg) return { key: 'err_target_gain' };
  if (d.goal === 'gain' && d.targetWeightKg! > MAX_WEIGHT_KG) return { key: 'err_weight' };
  return null;
}
