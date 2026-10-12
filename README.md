# OpenPlate

A free, open-source calorie tracker for iPhone and Android, built with Expo (React Native).
German and English, light and dark mode. Your diary is stored only on your phone; product searches go to Open Food Facts and meal photos go to the AI you choose.

**Features**

- **Food diary** with breakfast, lunch, dinner and snacks, calorie ring, macro bars and per-meal targets
- **Food search**: ~100 built-in basics (German and English names) as you type, plus millions of packaged products from [Open Food Facts](https://world.openfoodfacts.org) when you tap search (Open Food Facts allows 10 searches per minute, so the app never searches on every keystroke). Typing a barcode looks the product up directly.
- **Barcode scanner** (EAN-13/8, UPC) with Open Food Facts lookup; unknown products can be created on the spot
- **AI photo logging** with *your own* AI: Claude, OpenAI, Google Gemini (free tier), or a model running on your own PC via Ollama / LM Studio. Primary + fallback provider; the fallback is asked when the first fails or is unsure, and the more confident answer wins. Every item and portion can be corrected before saving.
- **Quick add**, **custom foods**, **recent foods**, **copy a meal from yesterday**
- **Personal plan** from a short onboarding (Mifflin-St Jeor + activity level + weekly pace), four macro presets. Once the target weight is reached the plan switches to holding it.
- **Safety limits**: weight-loss and fasting plans are for adults only (18+), weight-loss targets cannot go below a BMI of 18.5, and the calorie floor never turns a weight-loss plan into a surplus
- **Intermittent fasting**: 12:12, 14:10, 16:8, 18:6, 20:4, 23:1 timers with phases, adjustable start time and a notification when you reach the goal; 5:2 and 6:1 with chosen fasting days that lower the calorie goal automatically
- **Water tracker** with tappable glasses
- **Weight log** with chart (30/90/365 days), BMI, progress towards the target; weights can be added or corrected for past days
- **Steps** from the iPhone motion sensor, optionally added to the calorie budget (iPhone only; Android doesn't offer daily step history to apps without Health Connect)
- **Backup**: export all data to a file and import it again, e.g. on a new phone

Design notes (palette, type, the plate and the sprout): see [DESIGN.md](DESIGN.md).

---

## Install on your phone

Every push to `main` builds both apps on GitHub for free (Actions tab → *Build apps*, about 30 minutes) and publishes them under **[Releases](../../releases/latest)**.

### Android

1. On the phone, open the latest release and download **OpenPlate.apk**.
2. Open it and allow *Install unknown apps* for your browser when asked.
3. Updates: download the newer APK and install it over the old one. Your data stays.

APKs are signed with the project's own release key. Builds made before that change were signed with the shared debug key, so Android refuses to install a newer APK over them: once, export a backup (*Profile → Export data*), uninstall the old app, install the new APK and choose *Restore a backup* on the welcome screen.

### iPhone (free, with SideStore)

Apple only lets apps signed with a free Apple ID run for 7 days. **SideStore** renews the signature on the phone itself, so after a one-time setup with your PC you don't need to do anything.

**One-time setup on Windows**

1. Install **iTunes** from apple.com (the download from apple.com, not the Microsoft Store version) so Windows can talk to the iPhone.
2. Install **iloader** (the `.msi` from <https://github.com/nab138/iloader/releases>).
3. On the iPhone, install **LocalDevVPN** from the App Store, open it and tap *Connect*.
4. Plug the iPhone into the PC, tap *Trust*. In iloader, sign in with your normal Apple ID and click **SideStore (Stable)**.
5. On the iPhone: *Settings → General → VPN & Device Management* → trust your Apple ID. Then *Settings → Privacy & Security → Developer Mode* → on (the phone restarts).
6. Open SideStore and sign in with the same Apple ID.

**Add OpenPlate**

1. In SideStore → *Sources* → **+**, add:
   `https://github.com/louislam69/OpenPlate/releases/latest/download/source.json`
2. Tap **Get** next to OpenPlate.
3. New versions show up in SideStore with an **Update** button. Your data stays.

Keep LocalDevVPN installed; SideStore uses it to renew apps in the background. If OpenPlate ever stops opening, open SideStore and tap *Refresh All*.
Limits set by Apple for free Apple IDs: 3 sideloaded apps at once (SideStore counts as one) and 10 installs per week.

## Develop on your PC (optional)

Live-reload while changing the code, using the Expo Go app:

```powershell
npm install
npx expo install --fix
npx expo start
```

Scan the QR code with the phone camera. The project uses Expo **SDK 54**; Expo Go on the phone must support the same SDK (shown in Expo Go → Settings).

## Set up the AI photo feature

In the app: **Profile → AI settings**. Choose a primary and (optionally) a fallback AI.

| Provider | Cost | What you need |
|---|---|---|
| Google Gemini | free tier | Key from <https://aistudio.google.com/apikey>. On the free tier Google may use requests to improve its products. |
| Ollama (your PC) | free | See below |
| LM Studio (your PC) | free | Load a vision model, Developer tab → start server, enable *Serve on Local Network*. Address `http://<PC-IP>:1234/v1` |
| Claude | pay per use | Key from <https://console.anthropic.com> |
| OpenAI | pay per use | Key from <https://platform.openai.com/api-keys> |

Model names are editable in the app; defaults are `gemini-3.8-flash`, `claude-sonnet-5-5`, `gpt-6-luna`, `qwen2.5vl:7b`. Providers rename models from time to time, so if a test fails with "model not found", check the provider's model list.

**Ollama on Windows (free, private)**

1. Install from <https://ollama.com/download>.
2. Download a vision model: `ollama pull qwen2.5vl:7b` (about 6 GB; smaller alternative: `gemma3:4b`).
3. Let the iPhone reach it: Windows Settings → *Edit environment variables for your account* → new variable `OLLAMA_HOST` = `0.0.0.0` → quit Ollama from the tray and start it again. Allow it through the firewall on private networks.
4. Find your PC's address with `ipconfig` (IPv4 address, e.g. `192.168.1.20`).
5. In the app, set *Server address* to `http://<that address>:11434/v1` (e.g. `http://192.168.1.20:11434/v1`) and tap **Test connection**. There is no default address, so photos never go to a device you did not choose.

Plain `http://` addresses are only accepted for your own network (private IP ranges, `localhost`, `*.local`, Tailscale's `100.64.0.0/10`). Servers on the internet need `https://`, so photos and API keys are never sent unencrypted.

A local 7B model on a normal PC takes roughly 10–60 seconds per photo and is less accurate than the cloud models; using it as primary with Gemini as fallback works well.

API keys are stored in the iOS Keychain (expo-secure-store) and only ever sent to the provider they belong to.

## Project layout

```
app/                    screens (expo-router, file-based)
  (tabs)/index.tsx      diary
  (tabs)/fasting.tsx    fasting timer and plans
  (tabs)/progress.tsx   weight and weekly charts
  (tabs)/profile.tsx    settings, export
  onboarding.tsx        first-run plan setup
  add-food.tsx          search, recent, my foods
  food.tsx              portion picker / edit entry
  scan.tsx              barcode scanner
  photo.tsx             AI photo flow
  custom-food.tsx       create food / quick add
  ai-settings.tsx       bring-your-own-AI setup
src/lib/
  ai.ts                 providers, prompt, JSON parsing, fallback logic
  nutrition.ts          BMR/TDEE, goals, macros
  openFoodFacts.ts      barcode lookup and search
  genericFoods.ts       built-in basic foods
  fasting.ts            plans and phases
  i18n.ts               German and English texts
  goals.ts              daily goals, weight on a given day
  validation.ts         profile checks (age, healthy target weight)
  store.ts              persisted state (zustand)
  persistStorage.ts     storage split by month (AsyncStorage)
  migrations.ts         upgrades of stored data between versions
  backup.ts             backup file format and checks
tests/logic.test.ts     tests for the logic modules (npm test)
plugins/                Expo config plugin for Android release signing
```

Checks: `npm run check` (TypeScript) and `npm test` (logic tests).

## Release builds (maintainers)

The *Build apps* workflow only publishes a release when the type check and tests pass and the APK is signed with the project's own key. One-time setup:

1. Create a keystore (keep it and its passwords safe; losing it means users must reinstall again):
   `keytool -genkeypair -v -keystore openplate-release.jks -alias openplate -keyalg RSA -keysize 4096 -validity 10000`
2. In GitHub → *Settings → Secrets and variables → Actions*, add `ANDROID_KEYSTORE_BASE64` (output of `base64 -w0 openplate-release.jks`, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("openplate-release.jks"))` in PowerShell), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`openplate`) and, if different, `ANDROID_KEY_PASSWORD`.
3. Run `npm install && npx expo install --fix` locally and commit `package-lock.json`. From then on CI installs exactly the locked versions (`npm ci`); until then it warns on every run.

When the stored data layout changes, bump `STORE_VERSION` in `src/lib/migrations.ts` and add a migration step, otherwise users' data would be discarded.

## Not included yet

On the list for later:

- **Apple Health / Health Connect sync.** Steps already come from the phone's motion sensor.
- **Recipes**, meal plans, watch apps, cloud sync / accounts.
- App Store / Play Store listings.

## Credits and licence

- Code: MIT, see `LICENSE`.
- Product data: © Open Food Facts contributors, [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). The app shows this attribution wherever their data appears.
- Built-in basic foods: approximate averages compiled from public references such as USDA FoodData Central.

OpenPlate is an independent project and is not affiliated with any commercial nutrition app. It is not medical advice.
