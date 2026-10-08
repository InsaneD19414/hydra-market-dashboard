# HYDRA Market Dashboard - iPhone install, Shortcuts and Siri

> **PLACEHOLDER URL - not live until hosting is approved.** Replace it everywhere (re-run html2pwa with `--url`).

**App URL:** `https://insaned19414.github.io/hydra-market-dashboard/`

## Install on the Home Screen
1. Open the URL in **Safari** (scan `install_qr.png` / `install_card.png` with the Camera app).
2. Tap **Share** -> **Add to Home Screen** (iOS 26: keep **Open as Web App** on) -> **Add**.
3. Launch from the new icon: it opens full screen, without Safari's toolbar, and works offline after the first visit.
4. If the app uses the camera or microphone, tap **Allow** when asked (Settings -> Apps -> Safari -> Camera/Microphone if denied).

## Deep links
`?action=NAME` is handled by `pwa-deeplink.js`: it fires a `pwa:action` event, clicks `[data-pwa-action="NAME"]`, or scrolls to `#NAME`.
Configured actions: `?action=market`, `?action=gainers`, `?action=position`, `?action=bot`, `?action=journal`, `?action=alerts`.

## Shortcuts (build by hand - works on every iPhone, no Mac)
### Shortcut "HYDRA Market Dashboard Market"
1. Open **Shortcuts** -> **+** -> **Add Action** -> search **Open URLs** -> tap it.
2. Tap the **URL** field and type `https://insaned19414.github.io/hydra-market-dashboard/?action=market`
3. Tap the name at the top -> **Rename** -> `HYDRA Mkt Market` -> **Done**.
4. Siri: say **"Hey Siri, HYDRA Mkt Market"** (the shortcut name is the phrase).

### Shortcut "HYDRA Market Dashboard Gainers"
1. Open **Shortcuts** -> **+** -> **Add Action** -> search **Open URLs** -> tap it.
2. Tap the **URL** field and type `https://insaned19414.github.io/hydra-market-dashboard/?action=gainers`
3. Tap the name at the top -> **Rename** -> `HYDRA Mkt Gainers` -> **Done**.
4. Siri: say **"Hey Siri, HYDRA Mkt Gainers"** (the shortcut name is the phrase).

### Shortcut "HYDRA Market Dashboard Position"
1. Open **Shortcuts** -> **+** -> **Add Action** -> search **Open URLs** -> tap it.
2. Tap the **URL** field and type `https://insaned19414.github.io/hydra-market-dashboard/?action=position`
3. Tap the name at the top -> **Rename** -> `HYDRA Mkt Position` -> **Done**.
4. Siri: say **"Hey Siri, HYDRA Mkt Position"** (the shortcut name is the phrase).

### Shortcut "HYDRA Market Dashboard Bot"
1. Open **Shortcuts** -> **+** -> **Add Action** -> search **Open URLs** -> tap it.
2. Tap the **URL** field and type `https://insaned19414.github.io/hydra-market-dashboard/?action=bot`
3. Tap the name at the top -> **Rename** -> `HYDRA Mkt Bot` -> **Done**.
4. Siri: say **"Hey Siri, HYDRA Mkt Bot"** (the shortcut name is the phrase).

### Shortcut "HYDRA Market Dashboard Journal"
1. Open **Shortcuts** -> **+** -> **Add Action** -> search **Open URLs** -> tap it.
2. Tap the **URL** field and type `https://insaned19414.github.io/hydra-market-dashboard/?action=journal`
3. Tap the name at the top -> **Rename** -> `HYDRA Mkt Journal` -> **Done**.
4. Siri: say **"Hey Siri, HYDRA Mkt Journal"** (the shortcut name is the phrase).

### Shortcut "HYDRA Market Dashboard Alerts"
1. Open **Shortcuts** -> **+** -> **Add Action** -> search **Open URLs** -> tap it.
2. Tap the **URL** field and type `https://insaned19414.github.io/hydra-market-dashboard/?action=alerts`
3. Tap the name at the top -> **Rename** -> `HYDRA Mkt Alerts` -> **Done**.
4. Siri: say **"Hey Siri, HYDRA Mkt Alerts"** (the shortcut name is the phrase).

## Home Screen widget
Touch and hold the Home Screen -> **Edit** -> **Add Widget** -> **Shortcuts** -> pick a size -> **Add Widget** -> tap it to choose the shortcut.

## Action Button (iPhone 15 Pro and later)
**Settings -> Action Button** -> swipe to **Shortcut** -> **Choose a Shortcut** -> pick it.

## Signed shortcut files (Mac only)
iOS 15+ imports only **signed** `.shortcut` files. Unsigned files are in `shortcuts/`. On a Mac:
`shortcuts sign --mode anyone --input "X.unsigned.shortcut" --output "X.shortcut"`, then AirDrop to the iPhone.

## Honest limits
- `https://` links opened by Shortcuts open in **Safari**, which has storage separate from the Home Screen app. The undocumented `webapp://insaned19414.github.io/hydra-market-dashboard/` form is reported to open the installed web app on iOS 18. It is untested: verify it on a device.
- A real interactive widget requires a native app built in Xcode (WidgetKit). The Shortcuts widget is the no-Mac launcher.
- iOS suspends web apps in the background: timers, camera and microphone stop when the app is not on screen.
- Hosting must be HTTPS (GitHub Pages is). Deploy with `deploy/deploy_github_pages.sh --approved` only after approval.
