const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openStore } = require("../../src/copilot/main/store");
const { createIngestor } = require("../../src/copilot/rag/ingest");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { normalize } = require("../../src/copilot/rag/vectors");

// better-sqlite3 is built for Electron here: ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/ragStore.test.js
let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = { skip: canOpen ? false : "better-sqlite3 is not built for this runtime" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "copilot-rag-"));

// A toy embedding: a vector over a few topic words, so "similar" is checkable without a network.
const TOPICS = ["price", "refund", "onboarding", "holiday"];
const vecOf = (text) =>
  normalize(Float32Array.from(TOPICS.map((t) => (new RegExp(t, "i").test(text) ? 1 : 0.02))));
const fakeClients =
  (calls = []) =>
  () => ({
    embed: {
      dims: 4,
      embedDocs: async (docs) => (
        calls.push(docs.length),
        { vectors: docs.map((d) => vecOf(d.text)), tokens: docs.length * 10, cost: 0.001 }
      ),
      embedQueries: async (qs) => ({ vectors: qs.map(vecOf), tokens: 1, cost: 0 }),
      embedMedia: async () => ({ vector: vecOf("onboarding"), tokens: 5, cost: 0 }),
    },
    analyze: {
      summarize: async ({ name }) => ({ summary: `Summary of ${name}`, tokens: 7, cost: 0.002 }),
      readImage: async () => ({ text: "A price table image", tokens: 3, cost: 0 }),
    },
  });

function setup() {
  const dir = tmp();
  const store = openStore({ dbPath: path.join(dir, "c.db") });
  const pid = store.projects.create("Oyaara");
  const write = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return store.projects.addFileRow(pid, p, name);
  };
  return { dir, store, pid, write };
}

test(
  "a text file becomes chunks, a summary and a ready status; search finds it by meaning and by keyword",
  sqlite,
  async () => {
    const { store, pid, write } = setup();
    const calls = [];
    const logs = [];
    const ing = createIngestor({
      rag: store.rag,
      clients: fakeClients(calls),
      media: { available: () => false },
      log: (r) => logs.push(r),
    });
    const f = write(
      "plans.md",
      `# Price\n\nBasic costs twenty dollars a month. ${"Extra seats cost five dollars. ".repeat(40)}\n\n# Refund\n\nRefunds within 14 days, no questions. Oyaara guarantees it.`
    );
    await ing.ingest(f);
    const row = store.rag.file(f.id);
    assert.equal(row.status, "ready");
    assert.equal(row.summary, "Summary of plans.md");
    assert.ok(row.chunk_count >= 2);
    assert.equal(row.tokens > 0, true);
    assert.deepEqual(
      logs.map((l) => l.stage),
      ["read", "prepared", "embedded", "done"]
    );

    assert.equal(store.rag.hasIndex(pid), true);
    const hits = store.rag.vector(pid, vecOf("refund please"), 3);
    assert.match(store.rag.chunk(hits[0].id).text, /Refunds within 14 days/);
    const kw = store.rag.keyword(pid, "oyaara guarantee", 5);
    assert.equal(kw.length, 1);

    const r = createRetriever({ rag: store.rag, clients: fakeClients() });
    assert.match(r.catalog([pid]), /plans\.md: Summary of plans\.md/);
    const out = await r.retrieve({ query: "what is the refund policy", projectIds: [pid] });
    assert.match(out.text, /\[plans\.md · Refund\]/);
    assert.match(out.text, /14 days/);
    store.close();
  }
);

test(
  "indexing the same words again re-embeds nothing (vector cache), and removing a file removes its chunks",
  sqlite,
  async () => {
    const { store, pid, write } = setup();
    const calls = [];
    const ing = createIngestor({
      rag: store.rag,
      clients: fakeClients(calls),
      media: { available: () => false },
    });
    const f = write("a.md", "# Price\n\nBasic costs twenty dollars.");
    await ing.ingest(f);
    assert.deepEqual(calls, [1]);
    await ing.ingest(f); // retry after an edit that changed nothing
    assert.deepEqual(calls, [1, 0]);
    assert.equal(store.rag.chunkCount(pid), 1);
    store.projects.removeFile(f.id);
    assert.equal(store.rag.chunkCount(pid), 0);
    assert.equal(store.rag.hasIndex(pid), false);
    store.close();
  }
);

test(
  "a missing key, a too-big or unsupported file, and an empty file fail with a reason, not a crash",
  sqlite,
  async () => {
    const { store, write, dir } = setup();
    const noKey = createIngestor({
      rag: store.rag,
      clients: () => null,
      media: { available: () => false },
    });
    const f = write("a.md", "hello world, this is a note");
    await noKey.ingest(f);
    assert.equal(store.rag.file(f.id).status, "error");
    assert.match(store.rag.file(f.id).error, /OpenRouter key/);

    const ing = createIngestor({
      rag: store.rag,
      clients: fakeClients(),
      media: { available: () => false },
    });
    const exe = write("tool.exe", "MZ");
    await ing.ingest(exe);
    assert.match(store.rag.file(exe.id).error, /not supported/);
    const empty = write("empty.txt", "");
    await ing.ingest(empty);
    assert.match(store.rag.file(empty.id).error, /empty/i);
    const gone = store.projects.addFileRow(1, path.join(dir, "nope.md"), "nope.md");
    await ing.ingest(gone);
    assert.match(store.rag.file(gone.id).error, /not found/i);
    store.close();
  }
);

test(
  "an image is read, embedded together with its description, and unfinished files are listed for a restart",
  sqlite,
  async () => {
    const { store, pid, dir } = setup();
    const png = path.join(dir, "price.png");
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    const f = store.projects.addFileRow(pid, png, "price.png");
    assert.equal(store.rag.unfinished().length, 1); // never indexed
    const ing = createIngestor({
      rag: store.rag,
      clients: fakeClients(),
      media: { available: () => false },
    });
    await ing.ingest(f);
    const row = store.rag.file(f.id);
    assert.equal(row.status, "ready");
    assert.equal(store.rag.unfinished().length, 0);
    const c = store.rag.chunk(store.rag.vector(pid, vecOf("onboarding"), 1)[0].id);
    assert.equal(c.embed, "media");
    assert.equal(c.text, "A price table image");
    store.close();
  }
);

test("the project list carries each file's status for the page", sqlite, async () => {
  const { store, pid, write } = setup();
  const f = write("a.md", "# Price\n\nBasic costs twenty dollars.");
  const before = store.projects.list()[0].files[0];
  assert.equal(before.status, "queued");
  await createIngestor({
    rag: store.rag,
    clients: fakeClients(),
    media: { available: () => false },
  }).ingest(f);
  const after = store.projects.list().find((p) => p.id === pid).files[0];
  assert.equal(after.status, "ready");
  assert.equal(after.chunks, 1);
  assert.equal(after.summary, "Summary of a.md");
  store.close();
});

test(
  "search sees a file indexed after the first search (the vector cache is refreshed), and a file removed mid-index leaves nothing",
  sqlite,
  async () => {
    const { store, pid, write } = setup();
    const ing = createIngestor({
      rag: store.rag,
      clients: fakeClients(),
      media: { available: () => false },
    });
    await ing.ingest(write("a.md", "# Price\n\nBasic costs twenty dollars."));
    assert.equal(store.rag.vector(pid, vecOf("refund"), 5).length, 1);
    await ing.ingest(write("b.md", "# Refund\n\nRefunds within 14 days."));
    assert.equal(
      store.rag.vector(pid, vecOf("refund"), 5).length,
      2,
      "the second file is searchable"
    );
    const c = write("c.md", "# Holiday\n\nOffice closed in December.");
    const p = ing.ingest(c);
    store.projects.removeFile(c.id); // removed while queued/reading
    await p;
    assert.equal(store.rag.chunkCount(pid), 2);
    store.close();
  }
);
