# CheeseFork on your phone and iPad

CheeseFork runs on mobile in two ways, sharing the same code:

| | Android | iPad / iPhone |
|---|---|---|
| **Installable web app (PWA)** | Chrome → "Install app" | Safari → Share → "Add to Home Screen" |
| **Native app** | `CheeseFork-release.apk` (sideload) | Xcode project in `native/ios` (needs a Mac) |

Both get the mobile features below. The native app additionally gets class
and exam reminders (local notifications), a share sheet for the iCalendar
export, and an on-device cache of the course data.

## Mobile features

Shown automatically on phones, tablets, the installed PWA and the native app
(desktop browsers are unchanged):

- **Now & next card** – what's happening right now (with a progress bar and
  time left), what's next and where, "break until 12:30", "done for today",
  holidays from the Technion calendar, and a countdown to the next exam.
  Tap a building name to open it in Google Maps.
- **Day view** – a big, readable agenda of one day with breaks between
  lessons, instead of squeezing a six-day grid into a phone screen. Day chips
  switch days; today is underlined. Upcoming exams are listed underneath with
  "in N days" badges. The `?view=today` link (also a home-screen shortcut)
  opens it directly.
- **Reminders** (native app) – a notification before every lesson (5–60
  minutes, your choice), plus "exam tomorrow" and "exam today" reminders.
  They are computed from your schedule and re-synced on every change and
  every launch; lesson reminders are only scheduled while the semester is
  running. On Android 12+ the reminders dialog offers the system "alarms &
  reminders" permission; without it Android may deliver them a few minutes
  late.
- **Import a schedule from a share link** – paste a CheeseFork share link
  (yours from the website, or a friend's) to copy that schedule to the device.
  This is also the way to bring a Google-account schedule into the native app
  (see "Signing in" below). "Undo changes" restores the previous schedule.
- **"When are we both free?"** – paste a friend's share link and get the
  common free slots of the week, colour-coded by length.
- **Native sharing** – the share button uses the system share sheet
  (WhatsApp, etc.), and the iCalendar export in the native app opens the share
  sheet so you can add it straight to Google Calendar / Apple Calendar.
- **Offline** – the app shell and the course data of the last semesters are
  cached, so the app opens and shows your schedule without reception (lecture
  halls, trains...). Signed-in users also get a local copy of their Firestore
  data. An "offline" badge shows when the network is down.
- **Private grade book** (all platforms, "ציונים" in the menu) – enter a
  grade per course and get the semester, academic-year and cumulative
  weighted averages (by credit points; "עבר"/"פטור"/"נכשל" are supported).
  Grades are stored only on the device, never in the shared schedule, and
  live in their own dialog with a "hide grades" blur toggle, so showing
  someone your schedule never shows your grades. Backup/restore moves them
  between devices as text.
- **Home screen widget** (Android) – "השיעורים של היום": today's lessons
  with time, course, type, room and lecturer, the current one highlighted;
  after the last lesson it switches to the next day with lessons. Long-press
  the home screen → Widgets → CheeseFork. It refreshes whenever the schedule
  changes in the app and every 30 minutes. (iOS widgets need a Mac/Xcode
  and are not included.)
- **Install prompts**, dark-mode-aware status bar, hardware back button
  handling and a light haptic tap when adding/removing courses in the native
  app.

## Android

### Install the APK

1. Build it (below) or download `CheeseFork-release.apk` from the GitHub
   Actions run / release.
2. Copy the file to the phone (or open the GitHub link on the phone).
3. Tap the file. Android asks to allow installing from this source; allow it.
4. Open CheeseFork. On Android 13+ the app asks for notification permission
   the first time you enable reminders.

Updates: install the new APK over the old one. It must be signed with the
**same key** (the build script keeps the key in
`%LOCALAPPDATA%\cheesefork-tools\keystore`, back it up), otherwise Android
asks to uninstall first.

### Build locally (Windows)

Everything is portable (no Android Studio, no installers, no admin rights):

```powershell
powershell -ExecutionPolicy Bypass -File native\build-android.ps1
```

On the first run this downloads Node.js, a JDK and the Android SDK into
`%LOCALAPPDATA%\cheesefork-tools` (about 1.5 GB) and creates a signing key.
The APK ends up in `native\dist\CheeseFork-release.apk`. Options:
`-Debug` (debug build), `-Install` (install via adb on a USB-connected phone),
`-SkipSync` (just rebuild the APK).

To remove the toolchain, delete `%LOCALAPPDATA%\cheesefork-tools`.

### Build in GitHub Actions

`.github/workflows/android-apk.yml` builds the APK on every push that touches
the app, on manual dispatch, and attaches it to the release when you push a
tag like `app-v1.0.0`. Without secrets it produces a debug APK; add
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
and `ANDROID_KEY_PASSWORD` to also get a signed release APK
(`base64 -w0 cheesefork-release.jks` for the first one).

## iPad and iPhone

### The quick way: add to the home screen (PWA)

Apple doesn't allow installing apps outside the App Store without a Mac and
Xcode, so the easiest route is the PWA:

1. Open the site in **Safari** (the public site, or your own deployment of
   this repository, e.g. GitHub Pages).
2. Tap Share → **Add to Home Screen** → Add.

It opens full-screen with its own icon, works offline, and has all the
mobile features except notifications.

### The native app (needs a Mac)

`native/ios` is a ready Xcode project (generated by Capacitor):

```bash
cd native
npm install
npm run sync:ios          # assembles www and syncs the iOS project
npx cap open ios          # opens Xcode
```

In Xcode: select your team under Signing & Capabilities, connect the iPad,
and press Run. With a free Apple ID the app stays installed for 7 days
(re-run to refresh); with a paid developer account for a year, or publish via
TestFlight. Run `npm run assets` once to generate the app icons and splash
screens from `native/resources`.

## Signing in inside the native app

The app uses the real CheeseFork backend (same Firebase project, same
Firestore, same course data), so any account works on the website and in
the app alike.

**Only cheesefork.cf may talk to that backend.** The CheeseFork Firebase API
key is restricted by HTTP referrer: requests from any other origin
(`<user>.github.io`, `localhost`, …) are rejected with
`auth/requests-from-referer-…-are-blocked`. Consequences:

- On a fork served from GitHub Pages, signing in, cloud sync, share-link
  import and course feedback don't work. The schedule is still saved in the
  browser, and all mobile features that don't need the account work. The
  login dialog says so.
- The native app sets Capacitor's `server.hostname` to `cheesefork.cf`, so
  its pages run on the `https://cheesefork.cf` origin (served from the
  bundled files) and the backend accepts them. Don't change that setting.
  (On iOS the web view can't use the https scheme, so the iOS build would
  need the maintainer to allow another referrer.)

Google sign-in has one more limitation: Google blocks its sign-in page
inside embedded web views ("disallowed user agent"), so the native app only
offers **email/password** sign-in.

### Use your Google account in the app: add a password to it

Firebase accounts can have both Google and email/password sign-in. Once:

1. Open cheesefork.cf on a computer and sign in with Google.
2. Open the browser console (F12 → Console) and run, with your Gmail
   address and a password of your choice:

   ```js
   firebase.auth().currentUser.linkWithCredential(
       firebase.auth.EmailAuthProvider.credential('you@gmail.com', 'choose-a-password')
   ).then(function () { console.log('linked'); });
   ```

3. In the app, press "כניסה", choose email, and sign in with that address
   and password. It is the same account, with the same schedules; Google
   sign-in on the website keeps working.

If you prefer not to, the share-link route also works: on the website press
"Share schedule", then in the app press **Import** and paste the link.

## How it's built

- `mobile/platform.js` – early platform detection; in the native app it loads
  the course data through the native HTTP bridge with an on-device cache.
- `mobile/cheesefork-mobile.js` + `.css` – the mobile layer. It talks to the
  main app through the small `window.cheeseFork` API in `cheesefork.js`.
- `sw.js`, `manifest.webmanifest` – the PWA (web only).
- `native/` – the Capacitor project: `www` is assembled from the repository by
  `scripts/build-www.js`, then `cap sync` copies it into `android/` and `ios/`.

Try the web version locally with PWA support:

```bash
node native/scripts/serve.js
```
