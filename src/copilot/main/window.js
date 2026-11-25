// The copilot window: always on top, never takes focus away from the call when it opens, remembers its
// size and spot. Renderer = the app's own React bundle at ?copilot=true (see src/AppRouter.jsx).
//
// One frameless, transparent window with three modes, so a call keeps its screen:
//   orb   a small round button (draggable, remembers where it sits); pulses when something new is ready
//   peek  a small card next to the orb: the newest card; it goes back to the orb by itself
//   full  the whole panel (compact or expanded)
// The renderer draws what each mode looks like and asks for the mode it wants (`setMode`); this file
// only owns the bounds. Transparent corners need a compositing window manager; where there is none the
// window looks like a dark rectangle, which is why the panel and the orb both paint their own background.
const path = require("path");

const SIZES = { compact: { width: 460, height: 700 }, expanded: { width: 1180, height: 700 } };
const ORB = { width: 64, height: 64 };
const PEEK = { width: 380, height: 230 };
const MODES = new Set(["orb", "peek", "full"]);

function createCopilotWindow({
  BrowserWindow,
  screen,
  loadRenderer,
  setupAlwaysOnTop,
  getWindowState,
  saveWindowState,
  onVisibilityChange = () => {},
}) {
  let win = null;
  let mode = "full";
  let orbAt = null; // top-left of the orb; peek grows from its corner
  let dragTimer = null;
  let dragOffset = { x: 0, y: 0 };
  let pendingShow = false;
  let lastReportedOpen = false;

  const notifyVisibility = (open) => {
    const next = !!open;
    if (next === lastReportedOpen) return;
    lastReportedOpen = next;
    onVisibilityChange(next);
  };

  // Electron needs a whole rectangle of integers; the saved orb spot is only { x, y }.
  const areaOf = (b) =>
    screen.getDisplayMatching({
      x: Math.round(Number(b.x)) || 0,
      y: Math.round(Number(b.y)) || 0,
      width: Math.max(1, Math.round(Number(b.width)) || 1),
      height: Math.max(1, Math.round(Number(b.height)) || 1),
    }).workArea;
  // A saved rectangle from an older build or a hand-edited state file: only whole, finite numbers are kept,
  // anything else falls back to the default spot and size (Electron throws on NaN bounds).
  const savedRect = (b) =>
    b &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width > 0 &&
    b.height > 0
      ? b
      : null;
  const clampToScreen = (b) => {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return b;
    const area = areaOf(b);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - 120);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - 80);
    return { ...b, x, y };
  };
  const fit = (b) => {
    const area = areaOf(b);
    const width = Math.min(b.width, area.width);
    const height = Math.min(b.height, area.height);
    return {
      width,
      height,
      x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(b.y, area.y), area.y + area.height - height),
    };
  };
  const defaultOrbAt = () => {
    const d = screen.getPrimaryDisplay().workArea;
    return { x: d.x + d.width - ORB.width - 24, y: d.y + 96 };
  };

  function create({ focus, startMode }) {
    const state = getWindowState();
    const expanded = !!state.expanded;
    const saved = clampToScreen(savedRect(expanded ? state.expandedBounds : state.compact));
    const size = expanded ? SIZES.expanded : SIZES.compact;
    const display = screen.getPrimaryDisplay().workArea;
    const orb = clampToScreen(state.orb);
    orbAt = Number.isFinite(orb?.x) && Number.isFinite(orb?.y) ? orb : defaultOrbAt();
    mode = MODES.has(startMode) ? startMode : "full";
    const fullBounds = {
      width: saved?.width ?? size.width,
      height: saved?.height ?? size.height,
      // Default spot: right edge of the screen, out of the way of the call's own controls.
      x: saved?.x ?? display.x + display.width - size.width - 16,
      y: saved?.y ?? display.y + 48,
    };
    const first =
      mode === "orb" ? { ...ORB, ...orbAt } : mode === "peek" ? fit(peekBounds()) : fullBounds;
    win = new BrowserWindow({
      ...first,
      minWidth: mode === "full" ? 340 : 0,
      minHeight: mode === "full" ? 360 : 0,
      title: "Copilot",
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: mode === "full",
      skipTaskbar: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Hidden or covered, the window has nothing to do but apply events; let Chromium sleep its timers.
        backgroundThrottling: true,
      },
    });
    const w = win;
    w.setMenuBarVisibility(false);
    setupAlwaysOnTop(w);
    w.once("ready-to-show", () => {
      if (!pendingShow || w.isDestroyed()) return;
      focus ? w.show() : w.showInactive();
    });
    w.on("show", () => {
      pendingShow = false;
      notifyVisibility(true);
    });
    w.on("hide", () => {
      pendingShow = false;
      notifyVisibility(false);
    });
    const saveBounds = () => {
      if (w.isDestroyed() || w.isMinimized()) return;
      const b = w.getBounds();
      if (mode === "orb") {
        orbAt = { x: b.x, y: b.y };
        saveWindowState({ orb: orbAt });
      } else if (mode === "full") {
        saveWindowState(
          b.width > 800 ? { expanded: true, expandedBounds: b } : { expanded: false, compact: b }
        );
      }
    };
    let t = null;
    const later = () => (clearTimeout(t), (t = setTimeout(saveBounds, 400)));
    w.on("resize", later);
    w.on("move", later);
    // Chromium swallows mouse events over -webkit-app-region:drag (the header), so mouseenter never
    // fires there; poll the cursor against the window bounds instead.
    let wasOver = null; // null = renderer not told yet
    const hoverTimer = setInterval(() => {
      if (w.isDestroyed() || !w.isVisible()) return;
      const c = screen.getCursorScreenPoint();
      const b = w.getBounds();
      const over = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      if (over !== wasOver) {
        wasOver = over;
        send("copilot:hover", over);
      }
    }, 100);
    hoverTimer.unref?.();
    w.webContents.on("did-finish-load", () => (wasOver = null)); // a reloaded page must be told again
    w.on("closed", () => {
      stopDrag();
      clearTimeout(t);
      clearInterval(hoverTimer);
      if (win === w) {
        win = null;
        pendingShow = false;
        notifyVisibility(false);
      }
    });
    loadRenderer(w, "copilot").catch(() => {});
    return w;
  }

  // The peek hangs from the orb's corner nearest the screen edge, so it never leaves the screen.
  function peekBounds() {
    const o = orbAt ?? defaultOrbAt();
    const area = areaOf({ ...o, ...ORB });
    const right = o.x + ORB.width / 2 > area.x + area.width / 2;
    const below = o.y + ORB.height / 2 < area.y + area.height / 2;
    return {
      ...PEEK,
      x: right ? o.x + ORB.width - PEEK.width : o.x,
      y: below ? o.y : o.y + ORB.height - PEEK.height,
    };
  }

  const alive = () => !!(win && !win.isDestroyed());

  function stopDrag() {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    if (alive() && mode === "orb") {
      const b = win.getBounds();
      orbAt = { x: b.x, y: b.y };
      saveWindowState({ orb: orbAt });
    }
  }

  function startDrag() {
    if (!alive()) return;
    stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
    dragTimer = setInterval(() => {
      if (!alive()) {
        stopDrag();
        return;
      }
      const c = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const rawX = c.x - dragOffset.x;
      const rawY = c.y - dragOffset.y;
      const area = areaOf({ x: rawX, y: rawY, width: b.width, height: b.height });
      const x = Math.min(Math.max(rawX, area.x), area.x + area.width - b.width);
      const y = Math.min(Math.max(rawY, area.y), area.y + area.height - b.height);
      win.setPosition(Math.round(x), Math.round(y));
    }, 16);
  }

  function setMode(next) {
    if (!alive() || !MODES.has(next) || next === mode) return;
    stopDrag();
    // Leaving the orb: remember where it was dropped.
    if (mode === "orb") orbAt = { x: win.getBounds().x, y: win.getBounds().y };
    mode = next;
    const state = getWindowState();
    if (next === "orb") {
      win.setResizable(false);
      win.setMinimumSize(0, 0);
      win.setBounds({ ...ORB, ...(orbAt ?? defaultOrbAt()) });
    } else if (next === "peek") {
      win.setResizable(false);
      win.setMinimumSize(0, 0);
      win.setBounds(fit(peekBounds()));
    } else {
      win.setResizable(true);
      win.setMinimumSize(340, 360);
      const target = state.expanded
        ? (state.expandedBounds ?? SIZES.expanded)
        : (state.compact ?? SIZES.compact);
      const b = win.getBounds();
      win.setBounds(fit({ x: target.x ?? b.x, y: target.y ?? b.y, ...pickSize(target) }));
    }
    send("copilot:event", { type: "mode", mode });
  }
  const pickSize = (t) => ({ width: t.width, height: t.height });

  function send(channel, payload) {
    if (alive() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  return {
    isOpen: () => alive() && (win.isVisible() || pendingShow),
    mode: () => mode,
    open({ focus = false, startMode } = {}) {
      if (!alive()) {
        pendingShow = true;
        notifyVisibility(true);
        return create({ focus, startMode });
      }
      if (MODES.has(startMode) && mode !== startMode) setMode(startMode);
      if (!win.isVisible()) {
        pendingShow = true;
        notifyVisibility(true);
        focus ? win.show() : win.showInactive();
      } else if (focus) {
        win.focus();
      }
      return win;
    },
    // The hotkey: show it without stealing focus, or hide it ("presenting mode": events keep flowing, it is only hidden).
    toggle() {
      if (alive() && (win.isVisible() || pendingShow)) this.hide();
      else this.open({ focus: false });
    },
    hide() {
      pendingShow = false;
      if (alive()) win.hide();
      notifyVisibility(false);
    },
    close() {
      pendingShow = false;
      if (alive()) win.close();
      notifyVisibility(false);
    },
    send,
    webContents: () => (alive() ? win.webContents : null),
    setMode,
    startDrag,
    stopDrag,
    // Full mode only: switch between the compact panel and the three-pane one.
    expand(on) {
      if (!alive() || mode !== "full") return;
      const state = getWindowState();
      const target = on
        ? (savedRect(state.expandedBounds) ?? SIZES.expanded)
        : (savedRect(state.compact) ?? SIZES.compact);
      const b = win.getBounds();
      win.setBounds(
        fit({ x: target.x ?? b.x, y: target.y ?? b.y, width: target.width, height: target.height })
      );
    },
    setOpacity: (v) =>
      alive() &&
      win.setOpacity(Math.min(1, Math.max(0.3, Number.isFinite(Number(v)) ? Number(v) : 0.5))),
  };
}

module.exports = { createCopilotWindow, SIZES, ORB, PEEK };
