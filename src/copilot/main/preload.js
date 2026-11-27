// Bridge for the copilot window (sandboxed: only `electron` may be required here). Everything the
// window can do is listed below; the main process validates each call.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, ...args) => ipcRenderer.invoke(`copilot:${channel}`, ...args);

contextBridge.exposeInMainWorld("copilot", {
  onEvent(cb) {
    const listener = (_e, event) => cb(event);
    ipcRenderer.on("copilot:event", listener);
    ipcRenderer.send("copilot:ready"); // main replays the current meeting
    return () => ipcRenderer.removeListener("copilot:event", listener);
  },
  onHover(cb) {
    const listener = (_e, over) => cb(!!over);
    ipcRenderer.on("copilot:hover", listener);
    return () => ipcRenderer.removeListener("copilot:hover", listener);
  },
  ask: (q) => call("ask", q),
  transcribeAudio: (audioData, mimeType) => call("transcribe-audio", audioData, mimeType),
  pause: () => call("pause", true),
  resume: () => call("resume"),
  togglePause: () => call("pause-toggle"),
  rerun: (id) => call("rerun", id),
  cancel: (id) => call("cancel", id),
  createThread: (title) => call("thread-create", title),
  renameThread: (id, title) => call("thread-rename", id, title),
  closeThread: (id) => call("thread-close", id),
  feedback: (sessionId, jobId, value) => call("feedback", sessionId, jobId, value),
  getSettings: () => call("settings-get"),
  updateSettings: (patch) => call("settings-update", patch),
  projects: {
    list: () => call("projects-list"),
    create: (name) => call("project-create", name),
    rename: (id, name) => call("project-rename", id, name),
    update: (id, patch) => call("project-update", id, patch), // { name, instructions, plan }
    addRule: (id, kind, pattern) => call("project-rule-add", id, kind, pattern),
    removeRule: (id) => call("project-rule-remove", id),
    remove: (id) => call("project-remove", id),
    setActive: (id, active) => call("project-active", id, active),
    addFiles: (id) => call("project-add-files", id), // opens a file picker in main
    removeFile: (id) => call("project-remove-file", id),
    downloadFile: (id) => call("project-download-file", id),
    previewFile: (id) => call("project-preview-file", id),
    reindex: (id) => call("project-reindex", id), // index a file again (after a failure or a change)
  },
  // The project of the meeting on now: pick one (remember = teach the calendar rule), or null to clear.
  sessionProject: {
    get: () => call("session-project-get"),
    set: (id, remember) => call("session-project", id, remember),
  },
  sessions: {
    list: () => call("sessions-list"),
    get: (id) => call("sessions-get", id),
    remove: (id) => call("sessions-remove", id),
  },
  code: {
    listRepos: () => call("code-repos-list"),
    pickRepo: () => call("code-repo-pick"),
    refreshRepo: (repoDir) => call("code-repo-refresh", repoDir),
    removeRepo: (id) => call("code-repo-remove", id),
    analyze: (repoDir, query, topK) => call("code-analyze", repoDir, query, topK),
    branches: (repoDir) => call("code-branches", repoDir),
    diff: (repoDir, base, head) => call("code-diff", repoDir, base, head),
    modules: (repoDir) => call("code-modules", repoDir),
    getContextFile: (repoDir) => call("code-context", repoDir),
    downloadContextFile: (repoDir) => call("code-context-download", repoDir),
    getSummaryBundle: (repoDir) => call("code-summary-bundle", repoDir),
    exportSummaryBundle: (repoDir) => call("code-summary-export", repoDir),
    readSlices: (repoDir, sliceRequests) => call("code-read-slices", repoDir, sliceRequests),
  },
  openWindow: undefined,
  openReference: (ref) => call("open-reference", ref),
  openSettings: (section) => call("open-settings", section),
  stopMeeting: () => call("stop-meeting"),
  startMeeting: () => call("start-meeting"),
  window: (action, value) => call("window", action, value), // expand | mode (orb|peek|full) | opacity | hide | close
});
