# YouTube Music Desktop Client

A desktop client for **YouTube Music** built with **Electron**, designed as a lightweight and feature-rich wrapper around `music.youtube.com` for Windows with a focus on a clean interface, ad blocking, synced lyrics, and OS integration.

---

## Features

- **Full `music.youtube.com` web interface** — supports all playlists, recommendations, library, and account features.
- **AdBlock** — network-level blocking of ad and tracking requests, stripping `adPlacements` / `playerAds` / `adSlots` from player responses, hiding promo banners, and fallback auto-skip for video ads.
- **SponsorBlock** — automatic skipping of non-music segments (`music_offtopic`), sponsor segments, intros, and outros via the `sponsor.ajay.app` API.
- **Adaptive album-art background** — analyzes the color palette of the current track's cover art and smoothly tints the interface, player bar, and audio visualizer.
- **Synced lyrics** — enhances the standard Lyrics tab with time-synced LRC lyrics from `lrclib.net`, featuring active line highlighting, auto-scroll, click-to-seek, timing offset controls (`-0.5s` / `+0.5s`), and a toggle to switch back to native YouTube Music lyrics.
- **Audio visualizer** — frequency spectrum bar along the top edge of the player bar powered by the Web Audio API (`captureStream` + `AnalyserNode`) without interfering with audio output.
- **Windows System Tray & Taskbar** — minimize to tray on close, current track display, quick settings toggles, launch with Windows, and thumbnail toolbar buttons (`Previous`, `Play / Pause`, `Next`) on the Windows taskbar.
- **Global media keys** — system-wide playback control even when minimized.
- **Google Sign-In compatibility** — proper `Sec-CH-UA` headers and `navigator.userAgentData` properties, compatibility mode switcher (`Chrome` / `Firefox`), and fallback browser cookie import.

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + ,` | Open / close Settings window |
| `Ctrl + L` | Open / toggle synced lyrics tab |
| `MediaPlayPause` / `MediaNextTrack` / `MediaPreviousTrack` / `MediaStop` | Global playback controls |
| `Ctrl + Alt + Space` / `Ctrl + Alt + Right` / `Ctrl + Alt + Left` | Optional global shortcuts (enabled in Settings) |

---

## Installation & Usage

### Requirements

- **Windows 10 / 11** (x64)
- **Node.js** 20+ (tested on Node.js 24)

### 1. Clone and install dependencies

```powershell
git clone https://github.com/bohdan-bodashko/YTMusicClient.git
cd YTMusicClient
npm.cmd install
```

> Note: If PowerShell script execution policy restricts `.ps1` scripts, use `npm.cmd` instead of `npm`.

### 2. Run in development mode or via desktop shortcut

```powershell
npm.cmd start
```

To create a Windows Desktop shortcut (launches the app directly via `electron.exe` without a console window and with the app icon):

```powershell
npm.cmd run shortcut:desktop
```

### 3. Build `.exe` installer / portable binary

```powershell
npm.cmd run build
```

Built artifacts are generated in the `dist/` directory.

> Note on Windows Smart App Control / Defender: locally built unsigned `.exe` files may be blocked by Windows Application Control policies. For distribution, sign builds with a Code Signing certificate (`CSC_LINK` and `CSC_KEY_PASSWORD`), or launch the app via the shortcut created by `scripts/create-shortcut.ps1`.

---

## Google Account Sign-In

The client automatically aligns embedded environment properties with a standard browser. If Google still restricts embedded sign-in for a specific account:

1. Open Settings (`Ctrl + ,`) and switch to the **Google Account Sign-In** tab.
2. Click **Clear sign-in cache & reload** or switch the mode to **Firefox (fallback)**.
3. If needed, use **cookie import** from your regular browser (Chrome / Edge) by pasting the `Cookie:` header value from DevTools Network tab on `music.youtube.com`.

---

## Project Structure

```text
YTMusicClient/
├── assets/                   # App, tray, and taskbar thumbnail icons
├── scripts/
│   ├── create-shortcut.ps1   # Creates a Windows shortcut (.lnk)
│   └── generate-icons.py     # Generates PNG and ICO assets
├── src/
│   ├── main/
│   │   ├── adblocker.js      # Network-level ad and tracker blocking
│   │   ├── auth.js           # Auth headers, cache reset, and cookie import
│   │   ├── index.js          # Main process, window management, IPC, ThumbarButtons
│   │   ├── lyrics.js         # LRCLIB client, LRC parser, and artwork fetcher
│   │   ├── settings.js       # Settings persistence and sync
│   │   ├── shortcuts.js      # Global media shortcuts
│   │   ├── sponsorblock.js   # SponsorBlock API client
│   │   └── tray.js           # System tray and context menu
│   └── preload/
│       ├── auth-patcher.js   # Aligns navigator / userAgentData in MAIN world
│       ├── enhancements.js   # Adaptive background, lyrics tab, player bar controls
│       ├── index.js          # Isolated preload bridge, settings modal, shortcuts
│       └── page-patcher.js   # Player ad filtering, SponsorBlock, audio visualizer
├── package.json
└── README.md
```

---

## License

[MIT](LICENSE)
