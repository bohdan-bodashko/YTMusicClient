const { app, globalShortcut } = require('electron');

const MEDIA_SHORTCUTS = [
  ['MediaPlayPause', 'toggle'],
  ['MediaNextTrack', 'next'],
  ['MediaPreviousTrack', 'previous'],
  ['MediaStop', 'stop'],
];

const EXTRA_HOTKEYS = [
  ['CommandOrControl+Alt+Space', 'toggle'],
  ['CommandOrControl+Alt+Right', 'next'],
  ['CommandOrControl+Alt+Left', 'previous'],
];

class ShortcutManager {
  constructor(sendPlayerCommand) {
    this.sendPlayerCommand = sendPlayerCommand;
    this.registeredAccelerators = [];
    this.failedAccelerators = [];
  }

  apply(settings) {
    this.unregisterAll();
    if (!app.isReady()) return this.getStatus();

    if (settings.get('globalMediaKeys')) {
      for (const [accelerator, command] of MEDIA_SHORTCUTS) {
        this._register(accelerator, command);
      }
    }

    if (settings.get('extraHotkeys')) {
      for (const [accelerator, command] of EXTRA_HOTKEYS) {
        this._register(accelerator, command);
      }
    }

    return this.getStatus();
  }

  _register(accelerator, command) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        this.sendPlayerCommand(command);
      });
      if (ok) {
        this.registeredAccelerators.push(accelerator);
      } else {
        this.failedAccelerators.push(accelerator);
        console.warn(`[Shortcuts] Could not register: ${accelerator}`);
      }
    } catch (err) {
      this.failedAccelerators.push(accelerator);
      console.error(`[Shortcuts] Error registering ${accelerator}:`, err);
    }
  }

  getStatus() {
    return {
      registered: [...this.registeredAccelerators],
      failed: [...this.failedAccelerators],
    };
  }

  unregisterAll() {
    for (const accelerator of this.registeredAccelerators) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.registeredAccelerators = [];
    this.failedAccelerators = [];
  }
}

module.exports = { ShortcutManager };
