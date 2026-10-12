import type { AISettings } from './types';

/**
 * Version of the persisted state. Bump it together with a step in `migrateState` whenever the
 * stored shape changes; without a migration, zustand would drop the stored data on a version change.
 */
export const STORE_VERSION = 2;

/** Version 1 shipped with this address as the default for local AI servers. It is one specific
 * computer's LAN address (a common FritzBox range), so other users must not keep it by accident. */
export const OLD_LOCAL_DEFAULT_URL = 'http://192.168.178.20:11434/v1';

type Persisted = Record<string, unknown> & { ai?: Partial<AISettings> };

export function migrateState(persisted: unknown, fromVersion: number): Persisted {
  const state = { ...((persisted ?? {}) as Persisted) };

  if (fromVersion < 2) {
    // Clear the old hard-coded local server address unless the user actually uses a local server.
    const ai = state.ai;
    const local = ai?.providers?.local;
    const usesLocal = ai?.primary === 'local' || ai?.fallback === 'local';
    if (ai && local && local.baseUrl === OLD_LOCAL_DEFAULT_URL && !usesLocal) {
      state.ai = { ...ai, providers: { ...ai.providers!, local: { ...local, baseUrl: '' } } };
    }
  }

  return state;
}
