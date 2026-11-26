// test/copilot/vectorlessPipeline.test.js
// End-to-End verification that Code Ingestion, Retrieval, Local Search, and Scientist Synthesis
// execute with ZERO vector embeddings, ZERO vector searches, and ZERO GitHub API calls.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createIngestor } = require("../../src/copilot/rag/ingest");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { rrf } = require("../../src/copilot/rag/vectors");
const { createLocalCodeIndex } = require("../../src/copilot/rag/vectorlessCodeSearch");
const { createScientistSynthesizer } = require("../../src/copilot/core/answer/scientistSynthesizer");

function createInMemoryRagStore() {
  const files = new Map();
  const chunksByFile = new Map();
  let nextChunkId = 1;
  const allChunks = new Map();

  return {
    addFile(file) {
      files.set(file.id, { ...file, status: "queued" });
    },
    file(id) {
      return files.get(id) || null;
    },
    setFile(id, patch) {
      const cur = files.get(id) || { id };
      files.set(id, { ...cur, ...patch });
    },
    projectBytes: () => 0,
    chunkCount: () => allChunks.size,
    hasIndex: (pid) => [...files.values()].some((f) => f.project_id === pid && f.status === "ready"),
    catalog: (pid) =>
      [...files.values()]
        .filter((f) => f.project_id === pid && f.status === "ready")
        .map((f) => ({ ...f, profile: null })),
    cachedVectors: () => new Map(),
    replaceChunks(fileId, projectId, chunks, dims) {
      const stored = chunks.map((c) => {
        const id = nextChunkId++;
        const rec = {
          id,
          file_id: fileId,
          project_id: projectId,
          file: files.get(fileId)?.name || "file",
          text: c.text,
          meta: c.meta,
          embed: c.embed,
          hash: c.hash,
          dims,
          vec: c.vec,
        };
        allChunks.set(id, rec);
        return rec;
      });
      chunksByFile.set(fileId, stored);
    },
    getStoredChunks(fileId) {
      return chunksByFile.get(fileId) || [];
    },
    keyword(projectId, query, k = 12) {
      const terms = String(query || "").toLowerCase().match(/[a-z0-9_]+/g) || [];
      return [...allChunks.values()]
        .filter((c) => c.project_id === projectId && terms.some((t) => c.text.toLowerCase().includes(t)))
        .slice(0, k)
        .map((c) => c.id);
    },
    vector() {
      throw new Error("MUST NOT CALL rag.vector in vectorless mode!");
    },
    similarity() {
      throw new Error("MUST NOT CALL rag.similarity in vectorless mode!");
    },
    chunk: (id) => allChunks.get(id) || null,
    rrf,
  };
}

describe("100% Vectorless Code & Local Git Pipeline", () => {
  test("ingest.js indexes code files with ZERO calls to embedDocs/analyze and retrieve runs vectorless", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meethu-vec-test-"));
    const sampleFile = path.join(tmpDir, "billingService.ts");
    fs.writeFileSync(
      sampleFile,
      `/** Daily Billing Allowance Guard */
export class BillingAllowanceGuard {
  checkDailyLimit(userId: string, used: number, limit: number): boolean {
    if (used >= limit) throw new Error("DailyCreditLimitExceededError");
    return true;
  }
}`
    );

    const rag = createInMemoryRagStore();
    const fileId = 101;
    rag.addFile({ id: fileId, project_id: 1, path: sampleFile, name: "billingService.ts" });

    let embedCalls = 0;
    const ingestor = createIngestor({
      rag,
      clients: () => null, // No API key at all: proves code ingest works 100% offline/vectorless!
      media: { available: () => false },
    });

    await ingestor.ingest({ id: fileId, project_id: 1, path: sampleFile, name: "billingService.ts" });

    assert.strictEqual(embedCalls, 0, "embedDocs must NEVER be called for code files");
    const row = rag.file(fileId);
    assert.strictEqual(row.status, "ready");
    assert(row.chunk_count >= 1);

    const storedChunks = rag.getStoredChunks(fileId);
    assert(storedChunks.length >= 1);
    for (const c of storedChunks) {
      assert.strictEqual(c.embed, "lexical");
      assert.strictEqual(c.vec, null);
      assert.strictEqual(c.dims, null);
    }

    // Confirm retrieve({ vectorless: true }) finds it via lexical search with 0 embed calls
    const retriever = createRetriever({
      rag,
      clients: () => ({
        embed: {
          embedQueries: async () => {
            embedCalls++;
            throw new Error("MUST NOT CALL embedQueries in vectorless mode!");
          },
        },
      }),
    });

    const ret = await retriever.retrieve({
      query: "DailyCreditLimitExceededError checkDailyLimit",
      projectIds: [1],
      vectorless: true,
    });
    assert.strictEqual(embedCalls, 0, "embedQueries must NEVER be called in vectorless mode");
    assert.strictEqual(ret.embedMs, 0);
    assert.strictEqual(ret.cost, 0);
    assert(ret.used.length >= 1, "Lexical search should return matching code chunk");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("vectorlessCodeSearch & scientistSynthesizer run with 0 vector calls and 0 GitHub calls", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const idx = createLocalCodeIndex(path.join(repoRoot, "src/copilot/core/trigger"), { maxFiles: 10 });
    assert(idx.stats.codeModules >= 2);
    assert.strictEqual(idx.stats.vectorCalls, 0);

    const searchRes = idx.search("whenToCallRouter classifyIntent LOCAL_CODE_VECTORLESS");
    assert.strictEqual(searchRes.vectorCalls, 0);
    assert(searchRes.hits.length >= 1);
    assert(searchRes.hits[0].relPath.includes("whenToCallRouter"));

    const synth = createScientistSynthesizer({ repoDir: repoRoot, maxFiles: 30 });
    const out = synth.analyze("analyze whenToCallRouter.js");
    assert.strictEqual(out.telemetry.vectorCalls, 0);
    assert.strictEqual(out.telemetry.githubApiCalls, 0);
    assert.strictEqual(out.telemetry.embeddingTokens, 0);
    assert(out.markdown.includes("Scientist Code & Repository Analysis"));

    const singleFile = synth.compileContextFile({ maxModules: 25 });
    assert(singleFile.markdown.includes("# Repository Context:"));
    assert(singleFile.markdown.includes("## Directory & Module Tree"));
    assert(singleFile.markdown.includes("## Module-by-Module Code-to-MD Specifications"));
    assert.strictEqual(singleFile.metrics.vectorCalls, 0);
    assert.strictEqual(singleFile.metrics.githubApiCalls, 0);
  });
});
