const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.childNodes].map(textOf).join("");
}

const detail = (id, title) => ({
  session: {
    id,
    title,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_600_000,
    project_id: null,
  },
  segments: [],
  threads: [],
  cards: [],
});

async function mount(t, sessions) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { copilot: { sessions } } });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copilot-meetings-",
    mockModules: {
      "/ui/useToast": "export function useToast() { return { toast() {} }; }",
      "/ui/MarkdownRenderer": "export default function M({ content }) { return content; }",
    },
  });
  const Meetings = (await vite.ssrLoadModule("/components/copilot/CopilotMeetings.tsx")).default;
  root = createRoot(container);
  const render = (open) =>
    React.act(async () =>
      root.render(
        React.createElement(Meetings, {
          list: [],
          projects: [],
          reload() {},
          open,
          onOpen() {},
        })
      )
    );
  return { container, render };
}

test("a meeting that is no longer saved says so instead of loading forever", async (t) => {
  const { container, render } = await mount(t, { get: async () => null, list: async () => [] });
  await render("gone");
  const text = textOf(container);
  assert.doesNotMatch(text, /Loading/);
  assert.match(text, /no longer saved/);
  assert.match(text, /All meetings/);
});

test("the answer for a meeting opened earlier never replaces the one open now", async (t) => {
  const waits = {};
  const get = (id) =>
    new Promise((resolve) => (waits[id] = () => resolve(detail(id, `Meeting ${id}`))));
  const { container, render } = await mount(t, { get, list: async () => [] });
  await render("a");
  await render("b");
  await React.act(async () => waits.b());
  await React.act(async () => waits.a()); // the slow, older answer
  const text = textOf(container);
  assert.match(text, /Meeting b/);
  assert.doesNotMatch(text, /Meeting a/);
});

test("the meetings list says when it shows only the newest of more", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { copilot: { sessions: {} } } });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copilot-meetings-list-",
    mockModules: {
      "/ui/useToast": "export function useToast() { return { toast() {} }; }",
      "/ui/MarkdownRenderer": "export default function M({ content }) { return content; }",
    },
  });
  const Meetings = (await vite.ssrLoadModule("/components/copilot/CopilotMeetings.tsx")).default;
  const list = [1, 2].map((i) => ({
    id: `s${i}`,
    title: `Meeting ${i}`,
    started_at: 1_700_000_000_000,
    ended_at: null,
    summary: null,
    project_id: null,
    cards: 0,
  }));
  root = createRoot(container);
  const render = (total) =>
    React.act(async () =>
      root.render(
        React.createElement(Meetings, {
          list,
          total,
          projects: [],
          reload() {},
          open: null,
          onOpen() {},
        })
      )
    );
  await render(120);
  assert.match(textOf(container), /newest 2 of 120/);
  await render(2);
  assert.doesNotMatch(textOf(container), /newest/);
});
