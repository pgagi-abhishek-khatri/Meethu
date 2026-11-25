const test = require("node:test");
const assert = require("node:assert/strict");
const { createCopilotWindow, SIZES } = require("../../src/copilot/main/window");

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

function fakeElectron({ visibleOnCreate = true } = {}) {
  const created = [];
  class BrowserWindow {
    constructor(opts) {
      for (const k of ["x", "y", "width", "height"])
        if (opts[k] != null && !Number.isFinite(opts[k]))
          throw new TypeError(`bad ${k}: ${opts[k]}`);
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.visible = visibleOnCreate;
      this.destroyed = false;
      this.handlers = new Map();
      this.webContents = { isDestroyed: () => false, send() {}, on() {}, once() {} };
      created.push(this);
    }
    setMenuBarVisibility() {}
    setResizable() {}
    setMinimumSize() {}
    emit(event, ...args) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    once(event, fn) {
      const wrap = (...args) => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter((h) => h !== wrap)
        );
        fn(...args);
      };
      this.on(event, wrap);
    }
    on(event, fn) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    show() {
      this.visible = true;
      this.emit("show");
    }
    showInactive() {
      this.visible = true;
      this.emit("show");
    }
    hide() {
      this.visible = false;
      this.emit("hide");
    }
    close() {
      this.visible = false;
      this.destroyed = true;
      this.emit("closed");
    }
    focus() {}
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return false;
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(b) {
      for (const k of ["x", "y", "width", "height"])
        if (!Number.isFinite(b[k])) throw new TypeError(`bad ${k}: ${b[k]}`);
      this.bounds = b;
    }
    loadURL() {}
  }
  const screen = {
    getDisplayMatching: () => ({ workArea: AREA }),
    getPrimaryDisplay: () => ({ workArea: AREA }),
  };
  return { BrowserWindow, screen, created };
}

const open = (state) => {
  const e = fakeElectron();
  let saved = state;
  const w = createCopilotWindow({
    BrowserWindow: e.BrowserWindow,
    screen: e.screen,
    loadRenderer: () => Promise.resolve(),
    setupAlwaysOnTop: () => {},
    getWindowState: () => saved,
    saveWindowState: (p) => (saved = { ...saved, ...p }),
  });
  w.open({ startMode: "full" });
  return { w, win: e.created[0] };
};

test("window: saved bounds with bad numbers fall back to the default size and spot", () => {
  for (const compact of [
    { x: Number.NaN, y: 10, width: 400, height: 600 },
    { x: "100", y: 10, width: 400, height: 600 },
    { x: 10, y: 10, width: 0, height: 600 },
    { x: 10, y: 10 },
  ]) {
    const { win } = open({ expanded: false, compact, orb: { x: Number.NaN, y: 1 } });
    assert.equal(win.opts.width, SIZES.compact.width, JSON.stringify(compact));
    assert.ok(Number.isFinite(win.opts.x) && Number.isFinite(win.opts.y));
  }
});

test("window: good saved bounds are kept, and expand ignores a broken saved rectangle", () => {
  const { w, win } = open({
    expanded: false,
    compact: { x: 100, y: 50, width: 420, height: 650 },
    expandedBounds: { x: Number.NaN, y: 0, width: 1200, height: 700 },
  });
  assert.deepEqual([win.opts.x, win.opts.y, win.opts.width, win.opts.height], [100, 50, 420, 650]);
  assert.doesNotThrow(() => w.expand(true));
  assert.equal(win.bounds.width, SIZES.expanded.width);
});

test("window: isOpen stays true before ready-to-show and notifies on open, hide, and closed", () => {
  const e = fakeElectron({ visibleOnCreate: false });
  const events = [];
  const w = createCopilotWindow({
    BrowserWindow: e.BrowserWindow,
    screen: e.screen,
    loadRenderer: () => Promise.resolve(),
    setupAlwaysOnTop: () => {},
    getWindowState: () => ({ expanded: false }),
    saveWindowState: () => {},
    onVisibilityChange: (open) => events.push(open),
  });

  const win = w.open({ focus: true, startMode: "full" });
  assert.equal(win.isVisible(), false);
  assert.equal(w.isOpen(), true);
  assert.deepEqual(events, [true]);

  win.emit("ready-to-show");
  assert.equal(win.isVisible(), true);
  assert.equal(w.isOpen(), true);

  w.hide();
  assert.equal(w.isOpen(), false);
  assert.deepEqual(events, [true, false]);

  w.open({ focus: true, startMode: "full" });
  assert.equal(w.isOpen(), true);
  assert.deepEqual(events, [true, false, true]);

  win.close();
  assert.equal(w.isOpen(), false);
  assert.deepEqual(events, [true, false, true, false]);
});

test("window: open with startMode=full restores from orb mode after hide", () => {
  const e = fakeElectron({ visibleOnCreate: false });
  const w = createCopilotWindow({
    BrowserWindow: e.BrowserWindow,
    screen: e.screen,
    loadRenderer: () => Promise.resolve(),
    setupAlwaysOnTop: () => {},
    getWindowState: () => ({ expanded: false }),
    saveWindowState: () => {},
  });

  const win = w.open({ focus: true, startMode: "orb" });
  win.emit("ready-to-show");
  assert.equal(w.mode(), "orb");

  w.hide();
  w.open({ focus: true, startMode: "full" });
  assert.equal(w.mode(), "full");
  assert.equal(win.bounds.width, SIZES.compact.width);
  win.close();
});
