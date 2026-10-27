// Phase 0B window test. Throwaway Electron app, not part of the build.
//   X11 (what OpenWhispr uses today): env -u ELECTRON_RUN_AS_NODE npx electron scripts/copilot/window-test/main.js --ozone-platform=x11
//   native Wayland:                   env -u ELECTRON_RUN_AS_NODE npx electron scripts/copilot/window-test/main.js --ozone-platform=wayland
// Add --transparent to test a transparent window (needs a restart to change).
const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const posFile = path.join(app.getPath("userData"), "window-test-pos.json");
const transparent = process.argv.includes("--transparent");
let win;

const readPos = () => {
  try {
    return JSON.parse(fs.readFileSync(posFile, "utf8"));
  } catch {
    return {};
  }
};

app.whenReady().then(() => {
  const saved = readPos();
  win = new BrowserWindow({
    width: 420,
    height: 560,
    x: saved.x,
    y: saved.y,
    frame: !transparent,
    transparent,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  const savePos = () => fs.writeFileSync(posFile, JSON.stringify(win.getBounds()));
  win.on("moved", savePos);
  win.on("move", () => win.webContents.send("log", `moved to ${win.getPosition()}`));
  for (const ev of ["minimize", "restore", "show", "hide", "focus", "blur"]) {
    win.on(ev, () => win.webContents.send("log", `window event: ${ev}`));
  }

  const hotkeyOk = globalShortcut.register("CommandOrControl+Alt+J", () =>
    win.webContents.send("log", "GLOBAL HOTKEY fired (Ctrl+Alt+J)")
  );
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("env", {
      electron: process.versions.electron,
      ozone: app.commandLine.getSwitchValue("ozone-platform") || "(default)",
      session: process.env.XDG_SESSION_TYPE,
      desktop: process.env.XDG_CURRENT_DESKTOP,
      transparent,
      savedPos: saved,
      globalShortcutRegistered: hotkeyOk,
      savedPositionRestored: saved.x !== undefined,
    });
  });
});

ipcMain.on("always-on-top", (_e, on, level) => win.setAlwaysOnTop(on, level));
ipcMain.on("opacity", (_e, v) => win.setOpacity(v));
ipcMain.on("protect", (_e, on) => win.setContentProtection(on));
ipcMain.on("focusable", (_e, on) => win.setFocusable(on));
ipcMain.on("minimize-cycle", () => {
  win.minimize();
  setTimeout(() => win.restore(), 8000);
});
ipcMain.on("show-inactive", () => {
  win.hide();
  setTimeout(() => win.showInactive(), 1500);
});
// Read-only portal check: asks for a non-interactive screenshot and prints what
// the portal answers. A permission dialog (if any) is what we want to observe.
ipcMain.on("portal-screenshot", () => {
  execFile(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      "/org/freedesktop/portal/desktop",
      "--method",
      "org.freedesktop.portal.Screenshot.Screenshot",
      "",
      "{'interactive': <false>}",
    ],
    { timeout: 15000 },
    (err, stdout, stderr) =>
      win.webContents.send(
        "log",
        `portal screenshot: ${err ? "ERROR " + (stderr || err.message) : stdout.trim()}`
      )
  );
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
