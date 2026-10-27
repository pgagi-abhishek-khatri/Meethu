// The only file the app imports from the copilot. Everything else in src/copilot/ stays behind it,
// so upstream merges touch as little as possible.
const path = require("path");

// Dev (npm run dev) and production load the same React bundle; ?copilot=true picks the copilot screen.
function loadRenderer(win, flag) {
  const DevServerManager = require("../../helpers/devServerManager");
  if (process.env.NODE_ENV === "development") {
    return DevServerManager.waitForDevServer().then(() =>
      win.loadURL(`${DevServerManager.DEV_SERVER_URL}?${flag}=true`)
    );
  }
  const info = DevServerManager.getAppFilePath(false);
  return win.loadFile(info.path, { query: { ...info.query, [flag]: "true" } });
}

function startCopilot({ getActiveEvents } = {}) {
  const electron = require("electron");
  const { WindowPositionUtil } = require("../../helpers/windowConfig");
  const { createCopilot } = require("./service");
  const dev = process.env.COPILOT_DEV === "1" || process.env.COPILOT_LOG === "1";
  return createCopilot({
    dir: electron.app.getPath("userData"),
    // Per-meeting traces for reading after a meeting: only on request (they contain the transcript).
    logDir: dev ? path.join(electron.app.getAppPath(), "copilot-logs") : null,
    electron,
    loadRenderer,
    getActiveEvents,
    ffmpegPath: (() => {
      try {
        return require("../../helpers/ffmpegUtils").getFFmpegPath();
      } catch {
        return null;
      }
    })(),
    setupAlwaysOnTop: (w) => WindowPositionUtil.setupAlwaysOnTop(w),
  });
}

module.exports = { startCopilot, loadRenderer };
