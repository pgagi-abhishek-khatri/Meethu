#!/usr/bin/env node
// Runs the copilot tests under Electron's own Node runtime, the only one `better-sqlite3` is built for here. Under
// plain `node` (npm test) the sqlite-backed suites skip themselves, so this is the command that really covers them.
//   npm run test:copilot [-- extra/file.test.js ...]
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const electron = require("electron"); // the binary's path when required from Node
const given = process.argv.slice(2);
const files = given.length
  ? given
  : fs
      .readdirSync(path.join(root, "test/copilot"))
      .filter((f) => f.endsWith(".test.js"))
      .sort()
      .map((f) => path.join("test/copilot", f));

const res = spawnSync(electron, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(res.status ?? 1);
