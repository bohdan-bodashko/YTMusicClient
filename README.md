# YouTube Music Desktop Client

A desktop client for **YouTube Music** built with **Electron**, designed as a fast, refined wrapper around `music.youtube.com` for Windows with ad blocking, SponsorBlock, synced lyrics, a tray Mini Player, and native OS integration.

---

## Features

- **Full `music.youtube.com` web interface** — supports playlists, recommendations, library, search, and account features.
- **AdBlock** — network-level blocking of ad and tracking requests, stripping `adPlacements` / `playerAds` / `adSlots` from player responses, hiding promo banners, and edge-triggered fallback auto-skip for video ads.
- **SponsorBlock** — automatic skipping of non-music segments (`music_offtopic`), sponsors, self-promotions, interaction reminders, intros, and outros via `sponsor.ajay.app`, with configurable category toggles in Settings.
- **Adaptive album-art background** — extracts palette colors from the active track's cover art to smoothly tint the interface, player bar, and audio visualizer.
- **Synced lyrics** — enhances the Lyrics tab with time-synced LRC lyrics from `lrclib.net`, active line highlighting, smart auto-scroll with manual-scroll pause/resume, click-to-seek, timing offset controls (`-0.5s` / `+0.5s` / `Reset`), one-click copy, retry, and switching back to native YouTube Music lyrics.
- **Audio visualizer** — perceptual frequency spectrum bar along the top edge of the player bar via the Web Audio API (`captureStream` + `AnalyserNode`) without altering audio output.
- **Windows System Tray, Mini Player & Taskbar** — toggle the compact Mini Player flyout from the tray icon or the player bar button (album art, scrubbable progress bar, mute/volume slider, and pin-on-top), right-click tray menu controls, and high-contrast Windows taskbar thumbnail buttons (`Previous`, `Play / Pause`, `Next`).
- **Global media keys** — system-wide playback control even when minimized or hidden to tray.
- **Bilingual interface (English / Ukrainian)** — automatic system language detection on startup with live switching across main UI, Mini Player, tray menu, and offline screen.
- **Offline recovery screen** — clean connection-error view with one-click or hotkey retry when network access drops.
- **Google Sign-In compatibility** — aligned `Sec-CH-UA` headers and `navigator.userAgentData`, compatibility mode switcher (`Chrome` / `Firefox`), sign-in cache reset, and browser cookie import.

---

## Keyboard Shortcuts

### Main Window & Global

| Shortcut | Action |
| --- | --- |
| `Ctrl + ,` | Open / close Settings modal |
| `Ctrl + L` | Open / toggle synced lyrics tab |
| `Esc` | Close Settings modal |
| `Enter` / `R` | Retry loading from the offline error screen |
| `MediaPlayPause` / `MediaNextTrack` / `MediaPreviousTrack` / `MediaStop` | Global playback controls |
| `Ctrl + Alt + Space` / `Ctrl + Alt + Right` / `Ctrl + Alt + Left` | Optional global shortcuts (enabled in Settings) |

### Mini Player

| Shortcut | Action |
| --- | --- |
| `Space` | Play / Pause |
| `←` / `→` | Seek `-5s` / `+5s` |
| `↑` / `↓` | Volume `+5%` / `-5%` |
| `M` | Mute / Unmute |
| `Esc` | Hide Mini Player |

---

## Installation & Usage

### Option 1: Pre-built Windows Binaries (Recommended)

Download the latest release from [GitHub Releases](https://github.com/bohdan-bodashko/YTMusicClient/releases):

- **`YTMusicClient-1.2.0-setup.exe`** — Windows installer (customizable install directory, Start Menu & Desktop shortcuts, clean uninstaller).
- **`YTMusicClient-1.2.0-portable.exe`** — Standalone portable executable (runs directly without installation).

> Note on Windows Smart App Control / Defender: locally built unsigned `.exe` files may trigger a SmartScreen warning. Click **More info → Run anyway**, sign distributed builds with a Code Signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`), or build and launch from source via `scripts/create-shortcut.ps1`.

### Option 2: Build & Run from Source

#### Requirements

- **Windows 10 / 11** (x64)
- **Node.js** 20+ (tested on Node.js 24)
- **Python** 3.10+ (only needed if regenerating icon/installer assets)

#### 1. Clone and install dependencies

```powershell
git clone https://github.com/bohdan-bodashko/YTMusicClient.git
cd YTMusicClient
npm.cmd install
```

> Note: If PowerShell script execution policy blocks `.ps1` scripts, use `npm.cmd` and `npx.cmd` instead of `npm` / `npx`.

#### 2. Run in development mode or create shortcuts

```powershell
npm.cmd start          # Launch app
npm.cmd run dev        # Launch with DevTools / dev flags
npm.cmd run check      # Validate JS/HTML syntax, i18n parity, and image assets
```

Create a Desktop or Start Menu shortcut launching `electron.exe` cleanly with the app icon:

```powershell
npm.cmd run shortcut:desktop
npm.cmd run shortcut:startmenu
```

#### 3. Build Windows Installer & Portable `.exe`

```powershell
npm.cmd run build            # Clean dist/ and build both setup.exe & portable.exe
npm.cmd run build:nsis       # Build NSIS installer only
npm.cmd run build:portable   # Build portable executable only
npm.cmd run assets:icons     # Regenerate PNG, ICO, and NSIS/Portable BMP assets
```

Built artifacts are placed in `dist/`:
- `dist/YTMusicClient-<version>-setup.exe`
- `dist/YTMusicClient-<version>-portable.exe`

---

## Google Account Sign-In

The client aligns embedded browser headers and `navigator.userAgentData` with a standard browser. If Google still restricts sign-in for an account:

1. Open Settings (`Ctrl + ,`) and select the **Google Account Sign-In** tab.
2. Click **Clear sign-in cache & reload** or switch compatibility mode to **Firefox (fallback)**.
3. If needed, use **cookie import** from Chrome or Edge by pasting the `Cookie:` request header from DevTools Network tab on `music.youtube.com`.

---

## Project Structure

```text
YTMusicClient/
├── assets/                   # App icon, tray icons (@1x/@2x), and taskbar thumbar icons
├── build/                    # Branded 24-bit BMP assets for NSIS installer & portable splash
├── scripts/
│   ├── check.js              # Zero-dependency syntax, i18n parity, and asset integrity check
│   ├── create-shortcut.ps1   # Creates Windows Desktop / Start Menu shortcuts (.lnk)
│   └── generate-icons.py     # Generates PNG, ICO, and NSIS/Portable BMP assets
├── src/
│   ├── main/
│   │   ├── adblocker.js      # Network-level ad and tracker blocking
│   │   ├── auth.js           # Auth headers, cache reset, and cookie import
│   │   ├── index.js          # Main process, window lifecycle, IPC, ThumbarButtons
│   │   ├── lyrics.js         # LRCLIB client, LRC parser, and artwork fetcher
│   │   ├── miniplayer.js     # Tray flyout Mini Player window manager
│   │   ├── settings.js       # Atomic settings persistence, schema validation, and sync
│   │   ├── shortcuts.js      # Global media shortcuts
│   │   ├── sponsorblock.js   # SponsorBlock API client
│   │   └── tray.js           # System tray and context menu
│   ├── preload/
│   │   ├── auth-patcher.js   # Aligns navigator / userAgentData in MAIN world
│   │   ├── enhancements.js   # Adaptive background, synced lyrics, player bar controls
│   │   ├── index.js          # Main preload bridge, settings modal, hotkeys
│   │   ├── miniplayer.js     # Isolated preload bridge for the Mini Player
│   │   ├── offline.js        # Isolated preload bridge for the offline error screen
│   │   └── page-patcher.js   # Player ad filtering, SponsorBlock, audio visualizer
│   ├── renderer/
│   │   ├── miniplayer.html   # Tray Mini Player UI
│   │   └── offline.html      # Connection error & retry UI
│   └── shared/
│       ├── auth-hosts.js     # Shared Google/YouTube authentication host matching
│       └── i18n.js           # English / Ukrainian localization dictionary and helpers
├── package.json
└── README.md
```

---

## License

[MIT](LICENSE)
