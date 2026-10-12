import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BarChart, LineChart } from '../../src/components/charts';
import { TAB_BAR_SPACE } from '../../src/components/TabBar';
import { Button, Card, ChipGroup, IconButton, NumField, Row, Screen, SectionTitle, Txt } from '../../src/components/ui';
import { addDays, formatShortDate, lastNDays, locale, parseDayKey } from '../../src/lib/dates';
import { goalsFor, useToday } from '../../src/lib/hooks';
import { bmi, bmiCategory, isAdult, sumEntries, validWeight } from '../../src/lib/nutrition';
import { useStore, weightOn } from '../../src/lib/store';
import { useColors } from '../../src/lib/theme';
import { useT } from '../../src/lib/useT';

const RANGES = [30, 90, 365] as const;
/** How far back a weight can be logged or corrected. */
const BACKFILL_DAYS = 365;

export default function ProgressScreen() {
  const insets = useSafeAreaInsets();
  const { t, lang } = useT();
  const c = useColors();
  const profile = useStore((s) => s.profile)!;
  const weights = useStore((s) => s.weights);
  const entries = useStore((s) => s.entries);
  const water = useStore((s) => s.water);
  const logWeight = useStore((s) => s.logWeight);
  const removeWeight = useStore((s) => s.removeWeight);

  const today = useToday();
  const current = weightOn(weights, profile, today);
  const [logDate, setLogDate] = useState(today);
  const [input, setInput] = useState<number | null>(current);
  const [range, setRange] = useState<(typeof RANGES)[number]>(90);
  const [width, setWidth] = useState(0);

  // The day rolled over while the screen was open: keep logging for today.
  useEffect(() => {
    setLogDate((d) => (d > today ? today : d));
  }, [today]);

  const loggedOnDate = weights.find((w) => w.date === logDate);
  // Show the weight of the selected day (or the latest one before it) whenever the day or the data changes.
  useEffect(() => {
    setInput(loggedOnDate?.kg ?? weightOn(weights, profile, logDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logDate, loggedOnDate?.kg]);

  const dec = (n: number, d = 1) => n.toFixed(d).replace('.', t('decimal_sep'));
  const change = current - profile.startWeightKg;
  const toGo = current - profile.targetWeightKg;
  const bmiValue = bmi(current, profile.heightCm);
  const adult = isAdult(profile.birthYear);

  const shortLabel = (key: string) => parseDayKey(key).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short' });
  const points = useMemo(() => {
    const from = addDays(today, -range);
    return weights.filter((w) => w.date >= from).map((w) => ({ label: shortLabel(w.date), value: w.kg }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights, range, lang, today]);

  const week = lastNDays(today, 7);
  const bars = week.map((d) => ({
    label: parseDayKey(d).toLocaleDateString(locale(lang), { weekday: 'narrow' }),
    value: Math.round(sumEntries(entries.filter((e) => e.date === d)).kcal),
    goal: goalsFor(profile, weights, d).kcal,
  }));
  const loggedDays = bars.filter((b) => b.value > 0);
  const avgKcal = loggedDays.length ? Math.round(loggedDays.reduce((s, b) => s + b.value, 0) / loggedDays.length) : 0;
  const waterDays = week.filter((d) => (water[d] ?? 0) > 0);
  const avgWater = waterDays.length ? Math.round(waterDays.reduce((s, d) => s + water[d], 0) / waterDays.length) : 0;

  const save = () => {
    if (!validWeight(input)) return;
    logWeight(logDate, Math.round(input * 10) / 10);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  };

  const earliest = addDays(today, -BACKFILL_DAYS);
  const dateLabel = logDate === today ? t('today') : formatShortDate(logDate, lang);

  return (
    <Screen style={{ paddingTop: insets.top + 12 }} bottomInset={TAB_BAR_SPACE}>
      <Txt v="title">{t('tab_progress')}</Txt>

      <Card r="xl" style={{ paddingVertical: 22 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <Txt v="small">{t('current_weight')}</Txt>
            <Txt v="big">{dec(current)} kg</Txt>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Txt v="sub" color={change <= 0 ? c.accent : c.coral}>
              {change > 0 ? '+' : change < 0 ? '−' : '±'}
              {dec(Math.abs(change))} kg {t('since_start')}
            </Txt>
            {profile.goal !== 'maintain' ? (
              <Txt v="sub">{t('to_go', { kg: dec(Math.max(0, profile.goal === 'lose' ? toGo : -toGo)) })}</Txt>
            ) : null}
            {/* Adult BMI categories do not apply to children and teenagers (they need age percentiles). */}
            <Txt v="sub">{adult ? `BMI ${dec(bmiValue)} · ${t(`bmi_${bmiCategory(bmiValue)}`)}` : `BMI ${dec(bmiValue)}`}</Txt>
          </View>
        </Row>
        {!adult ? <Txt v="small">{t('bmi_minor_note')}</Txt> : null}
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {points.length > 0 ? (
            <LineChart points={points} width={width} target={profile.goal !== 'maintain' ? profile.targetWeightKg : undefined} />
          ) : (
            <Txt v="sub">{t('no_weights')}</Txt>
          )}
        </View>
        <ChipGroup options={RANGES.map((r) => ({ value: r, label: t('days_n', { n: r }) }))} value={range} onChange={setRange} />
      </Card>

      <Card style={{ gap: 12 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt v="h3">{loggedOnDate ? t('update_weight') : t('log_weight')}</Txt>
          <Row gap={2}>
            <IconButton
              icon="chevron-back"
              size={18}
              label={t('previous_day')}
              color={logDate <= earliest ? c.line : c.text}
              disabled={logDate <= earliest}
              onPress={() => setLogDate(addDays(logDate, -1))}
            />
            <Txt v="sub" style={{ minWidth: 84, textAlign: 'center' }}>
              {dateLabel}
            </Txt>
            <IconButton
              icon="chevron-forward"
              size={18}
              label={t('next_day')}
              color={logDate >= today ? c.line : c.text}
              disabled={logDate >= today}
              onPress={() => setLogDate(addDays(logDate, 1))}
            />
          </Row>
        </Row>
        <Row>
          <NumField value={input} onChange={setInput} suffix="kg" />
          <Button title={t('save')} icon="checkmark" onPress={save} disabled={!validWeight(input)} />
        </Row>
        {input !== null && !validWeight(input) ? (
          <Txt v="small" color={c.danger}>
            {t('err_weight')}
          </Txt>
        ) : null}
        {loggedOnDate ? (
          <Button
            small
            kind="ghost"
            title={t('remove_weight')}
            style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }}
            onPress={() =>
              Alert.alert(t('remove_weight'), dateLabel, [
                { text: t('cancel'), style: 'cancel' },
                { text: t('delete'), style: 'destructive', onPress: () => removeWeight(logDate) },
              ])
            }
          />
        ) : null}
      </Card>

      <SectionTitle>{t('last_7_days')}</SectionTitle>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt v="h3">{t('calories')}</Txt>
          <Txt v="sub">{t('avg_kcal', { kcal: avgKcal })}</Txt>
        </Row>
        <BarChart bars={bars} width={width} />
        <Txt v="small">{t('chart_goal_line')}</Txt>
      </Card>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt v="h3">{t('water')}</Txt>
          <Txt v="sub">{t('avg_water', { l: dec(avgWater / 1000, 2) })}</Txt>
        </Row>
      </Card>
    </Screen>
  );
}
