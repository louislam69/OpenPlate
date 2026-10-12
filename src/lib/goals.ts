import { isFastingDay } from './fasting';
import { dailyKcalGoal, fastingDayKcal, goalStatus, macroGrams } from './nutrition';
import type { Profile, WeightEntry } from './types';

/** Latest logged weight on or before the given day, else the start weight. */
export function weightOn(weights: WeightEntry[], profile: Profile, date: string): number {
  let kg = profile.startWeightKg;
  for (const w of weights) {
    if (w.date <= date) kg = w.kg;
    else break;
  }
  return kg;
}

/** Calorie and macro goals for one day, plus whether the weight goal is currently applied. */
export function goalsFor(profile: Profile, weights: WeightEntry[], date: string, now = new Date()) {
  const weight = weightOn(weights, profile, date);
  const fastDay = isFastingDay(profile, date, now);
  const status = goalStatus(profile, weight, now);
  const kcal = fastDay ? fastingDayKcal(profile.sex) : dailyKcalGoal(profile, weight, now);
  return { weight, fastDay, status, kcal, macros: macroGrams(kcal, profile.macroSplit) };
}
