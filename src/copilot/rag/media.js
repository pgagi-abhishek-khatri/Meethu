// Audio and video prepared with ffmpeg (bundled ffmpeg-static): one small working copy of the whole file, then
// cheap stream-copy cuts of it, so a long recording is transcoded once and sliced many times. Electron-free.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pool } = require("./openrouter");

function createMedia({
  ffmpegPath,
  tmpRoot = os.tmpdir(),
  concurrency = 2,
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  const slots = pool(concurrency);
  const run = (args, { allowFail = false } = {}) =>
    slots.run(
      () =>
        new Promise((resolve, reject) =>
          execFile(
            ffmpegPath,
            ["-hide_banner", "-nostdin", ...args],
            { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) =>
              err && !allowFail
                ? reject(
                    Object.assign(new Error(`ffmpeg: ${String(stderr).slice(-300)}`), {
                      code: "ffmpeg",
                    })
                  )
                : resolve(String(stderr))
          )
        )
    );

  return {
    available: () => !!ffmpegPath && fs.existsSync(ffmpegPath),
    makeDir: () => fs.mkdtempSync(path.join(tmpRoot, "ow-rag-")),
    // ffmpeg prints "Duration: 00:01:02.50" when asked to read a file and write nothing.
    async duration(file) {
      const out = await run(["-i", file], { allowFail: true });
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
    },
    // One working copy: audio = 16 kHz mono 32 kbps mp3; video = 360p, 2 fps, a key frame every 2 s, mono 32 kbps audio.
    async workingCopy(kind, input, dir) {
      const out = path.join(dir, kind === "video" ? "work.mp4" : "work.mp3");
      if (kind === "video")
        await run([
          "-y",
          "-i",
          input,
          "-vf",
          "scale=-2:360,fps=2",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "34",
          "-g",
          "4",
          "-c:a",
          "aac",
          "-b:a",
          "32k",
          "-ac",
          "1",
          "-movflags",
          "+faststart",
          out,
        ]);
      else await run(["-y", "-i", input, "-vn", "-ar", "16000", "-ac", "1", "-b:a", "32k", out]);
      return out;
    },
    // A cut of the working copy. Stream copy: fast, lands on the nearest key frame (video) or frame (audio).
    async cut(kind, work, dir, start, length, name) {
      const out = path.join(dir, `${name}.${kind === "video" ? "mp4" : "mp3"}`);
      await run(["-y", "-ss", String(start), "-i", work, "-t", String(length), "-c", "copy", out]);
      return out;
    },
    cleanup: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { createMedia };
