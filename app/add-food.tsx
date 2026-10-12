import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Sprout } from '../src/components/Sprout';
import { Card, Divider, Field, ListRow, Screen, SectionTitle, Tile, Txt, type IconName } from '../src/components/ui';
import { dayKey } from '../src/lib/dates';
import { putFood } from '../src/lib/foodCache';
import { foodSubtitle } from '../src/lib/format';
import { searchGeneric } from '../src/lib/genericFoods';
import { HttpError, isBarcode, lookupBarcode, RateLimitedError, searchOFF } from '../src/lib/openFoodFacts';
import { useStore } from '../src/lib/store';
import { useColors } from '../src/lib/theme';
import { MEALS, type Food, type MealType } from '../src/lib/types';
import { useT } from '../src/lib/useT';

export default function AddFoodScreen() {
  const params = useLocalSearchParams<{ meal?: string; date?: string }>();
  const meal: MealType = MEALS.includes(params.meal as MealType) ? (params.meal as MealType) : 'snack';
  const date = params.date ?? dayKey();
  const { t, lang } = useT();
  const c = useColors();
  const recent = useStore((s) => s.recentFoods);
  const custom = useStore((s) => s.customFoods);

  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Food[]>([]);
  /** The query the product results belong to; products are only searched on submit. */
  const [searched, setSearched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingCode, setMissingCode] = useState<string | null>(null);
  const requestId = useRef(0);

  const q = query.trim();
  const local = useMemo(() => {
    if (!q) return [];
    const ql = q.toLowerCase();
    const mine = [...custom, ...recent].filter(
      (f, i, arr) => f.name.toLowerCase().includes(ql) && arr.findIndex((x) => x.id === f.id) === i,
    );
    const generic = searchGeneric(q, lang).filter((g) => !mine.some((m) => m.id === g.id));
    return [...mine.slice(0, 6), ...generic];
  }, [q, custom, recent, lang]);

  // Typing only filters local foods; a new query hides the products found for the previous one.
  useEffect(() => {
    setError(null);
    setMissingCode(null);
  }, [q]);

  const open = (f: Food) => {
    putFood(f);
    router.push({ pathname: '/food', params: { fid: f.id, meal, date } });
  };

  const submit = async () => {
    if (q.length < 2 || loading) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setMissingCode(null);
    try {
      if (isBarcode(q)) {
        // A barcode typed by hand: look up the product directly instead of searching text.
        const code = q.replace(/\D/g, '');
        const food = custom.find((f) => f.barcode === code) ?? (await lookupBarcode(code, lang));
        if (id !== requestId.current) return;
        if (food) open(food);
        else setMissingCode(code);
        return;
      }
      const res = await searchOFF(q, lang);
      if (id !== requestId.current) return;
      setRemote(res.filter((r) => !local.some((l) => l.id === r.id)));
      setSearched(q);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof RateLimitedError || (e instanceof HttpError && e.status === 429) ? t('search_rate_limited') : t('search_failed'));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  const showProducts = searched === q;

  const renderFood = (f: Food) => (
    <ListRow
      key={f.id}
      title={f.name}
      subtitle={foodSubtitle(f)}
      onPress={() => open(f)}
      right={<Ionicons name="add-circle" size={26} color={c.accent} />}
    />
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: t(`meal_${meal}`) }} />
      <Field
        placeholder={t('search_placeholder')}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={submit}
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Action icon="barcode-outline" bg={c.meal.breakfast.tile} color={c.meal.breakfast.icon} label={t('scan')} onPress={() => router.push({ pathname: '/scan', params: { meal, date } })} />
        <Action icon="sparkles" bg={c.accent} color={c.accentText} label={t('ai_photo_short')} onPress={() => router.push({ pathname: '/photo', params: { meal, date } })} />
        <Action icon="flash" bg={c.meal.dinner.tile} color={c.meal.dinner.icon} label={t('quick_add')} onPress={() => router.push({ pathname: '/custom-food', params: { meal, date, mode: 'quick' } })} />
        <Action icon="create" bg={c.meal.lunch.tile} color={c.meal.lunch.icon} label={t('create_food_short')} onPress={() => router.push({ pathname: '/custom-food', params: { meal, date } })} />
      </View>

      {q ? (
        <>
          {local.length > 0 ? <Card>{local.map(renderFood)}</Card> : null}
          <SectionTitle right={loading ? <ActivityIndicator color={c.accent} /> : undefined}>{t('products')}</SectionTitle>
          {error ? <Txt v="sub">{error}</Txt> : null}
          {missingCode ? (
            <Card>
              <ListRow
                title={t('not_found_text', { code: missingCode })}
                subtitle={t('create_food')}
                onPress={() => router.push({ pathname: '/custom-food', params: { meal, date, barcode: missingCode } })}
                right={<Ionicons name="create-outline" size={22} color={c.accent} />}
              />
            </Card>
          ) : null}
          {!showProducts && !missingCode && q.length >= 2 ? (
            <Card>
              <ListRow
                title={isBarcode(q) ? t('lookup_barcode', { code: q }) : t('search_products_for', { q })}
                onPress={submit}
                right={<Ionicons name="search" size={22} color={c.accent} />}
              />
            </Card>
          ) : null}
          {showProducts && !loading && !error && remote.length === 0 ? <Txt v="sub">{t('no_results')}</Txt> : null}
          {showProducts && remote.length > 0 ? <Card>{remote.map(renderFood)}</Card> : null}
          <Txt v="small">{t('off_attribution')}</Txt>
        </>
      ) : (
        <>
          {recent.length > 0 ? (
            <>
              <SectionTitle>{t('recent')}</SectionTitle>
              <Card>{recent.slice(0, 15).map(renderFood)}</Card>
            </>
          ) : null}
          {custom.length > 0 ? (
            <>
              <SectionTitle>{t('my_foods')}</SectionTitle>
              <Card>
                {custom.map((f, i) => (
                  <React.Fragment key={f.id}>
                    {i > 0 ? <Divider /> : null}
                    {renderFood(f)}
                  </React.Fragment>
                ))}
              </Card>
            </>
          ) : null}
          {recent.length === 0 && custom.length === 0 ? (
            <View style={{ alignItems: 'center', gap: 8, paddingVertical: 20 }}>
              <Sprout size={100} />
              <Txt v="sub" center style={{ maxWidth: 280 }}>
                {t('add_food_empty')}
              </Txt>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function Action({ icon, label, onPress, bg, color }: { icon: IconName; label: string; onPress: () => void; bg: string; color: string }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1,
        backgroundColor: c.card,
        borderRadius: 20,
        paddingVertical: 14,
        alignItems: 'center',
        gap: 8,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Tile icon={icon} bg={bg} color={color} size={42} />
      <Txt v="label" color={c.text} center numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  );
}
