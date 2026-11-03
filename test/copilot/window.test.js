const test = require("node:test");
const assert = require("node:assert/strict");
const { createCopilotWindow, SIZES } = require("../../src/copilot/main/window");

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };

function fakeElectron() {
  const created = [];
  class BrowserWindow {
    constructor(opts) {
      for (const k of ["x", "y", "width", "height"])
        if (opts[k] != null && !Number.isFinite(opts[k]))
          throw new TypeError(`bad ${k}: ${opts[k]}`);
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.webContents = { isDestroyed: () => false, send() {}, on() {}, once() {} };
      created.push(this);
    }
    setMenuBarVisibility() {}
    once() {}
    on() {}
    isDestroyed() {
      return false;
    }
    isVisible() {
      return true;
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
