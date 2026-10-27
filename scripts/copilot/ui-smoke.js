// Opens the real copilot window with a fake engine and takes screenshots (compact + expanded).
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/copilot/ui-smoke.js <outDir>   (needs `npm run build:renderer` first)
const { app, BrowserWindow, screen, ipcMain, dialog } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const out = process.argv[2] || os.tmpdir();
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { createCopilot } = require(path.join(root, "src/copilot/main/service"));
  let n = 0;
  const main = ({ messages, onDelta, signal }) =>
    new Promise((resolve) => {
      const text = `TITLE: ${["Net revenue retention", "Pricing check", "Side answer"][n++ % 3]}\nNRR is revenue from existing customers after churn and upsell.\n\n- Above **100%** means growth without new logos\n- SaaS median is roughly 100-110%\nCONFIDENCE: high`;
      setTimeout(
        () => (
          onDelta(text),
          resolve({
            text,
            sources: [
              {
                url: "https://www.investopedia.com/terms/n/nrr.asp",
                title: "NRR",
                snippet: "Net revenue retention measures...",
              },
            ],
            usage: null,
            firstTokenMs: 800,
            totalMs: 2100,
          })
        ),
        400
      );
      signal.addEventListener("abort", () => resolve({ text: "", sources: [] }));
    });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ui-"));
  const copilot = createCopilot({
    dir,
    env: { OPENROUTER_API_KEY: "x" },
    electron: { app, BrowserWindow, screen, ipcMain, dialog, safeStorage: null },
    loadRenderer: (win, flag) =>
      win.loadFile(path.join(root, "src/dist/index.html"), { query: { [flag]: "true" } }),
    setupAlwaysOnTop: () => {},
    engineOptions: {
      mainModel: main,
      llm: async () => ({ text: "The team is reviewing the pricing model and the renewal risk." }),
      client: {
        systemOne: async ({ questions }) => ({
          answers:
            "act" in questions
              ? {
                  act: { type: "noul", noul: 0.9 },
                  chatter: { type: "noul", noul: 0 },
                  help: { type: "noul", noul: 1 },
                  complete: { type: "noul", noul: 0.95 },
                  kind: {
                    type: "choice",
                    choice: "quick_answer",
                    confidence: 0.9,
                    probabilities: { quick_answer: 0.9, explanation: 0.1 },
                  },
                  needs_web: { type: "noul", noul: 0.1 },
                  asked_of_assistant: { type: "noul", noul: 0.05 },
                }
              : { asked_of_assistant: { type: "noul", noul: 0.05 } },
          inputTokens: 100,
        }),
      },
    },
  });
  copilot.settings.update({ plan: "Goal: renewal with Acme. Ask about pricing." });
  copilot.begin();
  await new Promise((r) => setTimeout(r, 2500));
  const say = (source, text) => copilot.onFinal({ text, source, timestamp: Date.now() });
  say("system", "Our net revenue retention dropped last quarter, what is a healthy NRR for us?");
  say("mic", "I think we are around one hundred and five percent.");
  say("system", "And what about the renewal timeline for Acme?");
  copilot.engine.createThread({ title: "Pricing" });
  copilot.engine.ask({ text: "What is typical SaaS churn?", threadId: "t1" });
  await new Promise((r) => setTimeout(r, 3500));
  const w = BrowserWindow.getAllWindows()[0];
  copilot.window.setMode("full");
  await new Promise((r) => setTimeout(r, 900));
  const shot = async (name) =>
    fs.writeFileSync(path.join(out, name), (await w.webContents.capturePage()).toPNG());
  await shot("copilot-compact.png");
  copilot.window.setMode("full");
  w.setSize(1180, 700);
  await new Promise((r) => setTimeout(r, 1200));
  await shot("copilot-expanded.png");
  await w.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Transcript')?.click()`
  );
  await new Promise((r) => setTimeout(r, 500));
  await shot("copilot-transcript.png");
  await w.webContents.executeJavaScript(
    `document.querySelector('button[title="Settings"]')?.click()`
  );
  await new Promise((r) => setTimeout(r, 500));
  await shot("copilot-settings.png");
  // small modes: the orb, and the peek a new card brings
  copilot.window.setMode("orb");
  await new Promise((r) => setTimeout(r, 900));
  await shot("copilot-orb.png");
  copilot.window.setMode("peek");
  await new Promise((r) => setTimeout(r, 900));
  await shot("copilot-peek.png");
  copilot.window.setMode("full");
  await new Promise((r) => setTimeout(r, 900));
  console.log("shots written to", out);
  app.exit(0);
});
