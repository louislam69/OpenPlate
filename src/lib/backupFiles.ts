import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import { BackupError, makeBackup, parseBackup } from './backup';
import { dayKey } from './dates';
import { cancelAllNotifications } from './device';
import { useStore } from './store';
import type { TFn } from './useT';

/** Writes all data to a JSON file and opens the share sheet (Files, AirDrop, mail, …). */
export async function exportBackupFile(t: TFn): Promise<void> {
  const data = makeBackup(useStore.getState());
  const file = new File(Paths.cache, `openplate-backup-${dayKey()}.json`);
  if (file.exists) file.delete();
  file.create();
  file.write(JSON.stringify(data, null, 2));
  if (!(await Sharing.isAvailableAsync())) throw new Error(t('share_unavailable'));
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: t('export_data') });
}

/**
 * Lets the user pick a backup file, asks before replacing the current data and imports it.
 * Resolves to true when data was imported.
 */
export async function importBackupFile(t: TFn): Promise<boolean> {
  const picked = await DocumentPicker.getDocumentAsync({
    // Some file providers report .json files as plain text or octet-stream; parseBackup validates.
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || !picked.assets?.length) return false;

  let parsed: ReturnType<typeof parseBackup>;
  try {
    parsed = parseBackup(await new File(picked.assets[0].uri).text());
  } catch (e) {
    const code = e instanceof BackupError ? e.code : 'not_json';
    Alert.alert(t('error'), t(`import_error_${code}`));
    return false;
  }

  const confirmed = await new Promise<boolean>((resolve) =>
    Alert.alert(t('import_confirm_q'), t('import_confirm_text', { n: parsed.backup.entries.length }), [
      { text: t('cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: t('import_data'), style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
  if (!confirmed) return false;

  // A fast that was running here is replaced by the backup's data; its reminder must not fire.
  await cancelAllNotifications();
  useStore.getState().importBackup(parsed.backup);
  Alert.alert(t('import_done'), parsed.skipped ? t('import_skipped', { n: parsed.skipped }) : undefined);
  return true;
}
