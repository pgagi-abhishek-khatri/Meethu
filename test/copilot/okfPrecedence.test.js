// Phase 5.4: the manifest's four precedence rules, implemented once.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  KIND_RANK,
  STATUS_RANK,
  rankDocuments,
  outranks,
  resolveSuperseded,
} = require("../../src/copilot/core/okf/precedence");
const { standingMap } = require("../../src/copilot/rag/docPrecedence");
const { buildSystemPrompt } = require("../../src/copilot/prompts/main");

const d = (o) => ({
  id: "X",
  kind: "canonical",
  status: "approved",
  version: "1.0.0",
  updated_at: "2026-01-01T00:00:00Z",
  ...o,
});

test("rule 1: a canonical OKF document outranks notes and old proposals", () => {
  assert.ok(outranks(d({ kind: "canonical" }), d({ kind: "notes" })));
  assert.ok(outranks(d({ kind: "canonical" }), d({ kind: "proposal" })));
});

test("rule 2: approved outranks draft, deprecated and unverified, whatever the kind", () => {
  assert.ok(
    outranks(d({ status: "approved", kind: "proposal" }), d({ status: "draft", kind: "canonical" }))
  );
  assert.ok(outranks(d({ status: "draft" }), d({ status: "deprecated" })));
  assert.ok(STATUS_RANK.approved > STATUS_RANK.draft && STATUS_RANK.draft > STATUS_RANK.deprecated);
  assert.equal(STATUS_RANK.unverified ?? 0, 0);
});

test("rule 3: a newer semantic version outranks an older one (numerically, not as text)", () => {
  assert.ok(outranks(d({ version: "1.10.0" }), d({ version: "1.9.0" })));
  assert.ok(outranks(d({ version: "2.0.0" }), d({ version: "1.99.99" })));
});

test("rule 4: as-built outranks a proposal", () => {
  assert.ok(outranks(d({ kind: "built" }), d({ kind: "proposal" })));
  assert.ok(KIND_RANK.canonical > KIND_RANK.built && KIND_RANK.built > KIND_RANK.change);
  assert.ok(KIND_RANK.requirement > KIND_RANK.proposal);
});

test("ties fall to the newer date, then to the id so the order is stable", () => {
  assert.ok(
    outranks(d({ updated_at: "2026-06-01T00:00:00Z" }), d({ updated_at: "2026-01-01T00:00:00Z" }))
  );
  const a = d({ id: "A" });
  const b = d({ id: "B" });
  assert.deepEqual(
    rankDocuments([b, a]).map((x) => x.id),
    ["A", "B"]
  );
  assert.deepEqual(
    rankDocuments([a, b]).map((x) => x.id),
    ["A", "B"]
  );
});

test("an invalid version never throws: it ranks below any valid one", () => {
  assert.doesNotThrow(() => rankDocuments([d({ version: "banana" }), d({ version: "1.0.0" })]));
  assert.ok(outranks(d({ version: "0.0.1" }), d({ version: "banana" })));
});

test("rankDocuments sorts best first without mutating its input", () => {
  const input = [
    d({ id: "old", version: "1.0.0" }),
    d({ id: "new", version: "2.0.0" }),
    d({ id: "draft", status: "draft" }),
  ];
  const copy = input.slice();
  assert.deepEqual(
    rankDocuments(input).map((x) => x.id),
    ["new", "old", "draft"]
  );
  assert.deepEqual(input, copy);
});

test("a superseded document redirects to its approved successor, following the chain", () => {
  const docs = new Map([
    ["OKF-0001", { id: "OKF-0001", status: "superseded", superseded_by: "OKF-0002" }],
    ["OKF-0002", { id: "OKF-0002", status: "superseded", superseded_by: "OKF-0003" }],
    ["OKF-0003", { id: "OKF-0003", status: "approved" }],
  ]);
  const r = resolveSuperseded(docs.get("OKF-0001"), (id) => docs.get(id) ?? null);
  assert.equal(r.doc.id, "OKF-0003");
  assert.deepEqual(r.chain, ["OKF-0001", "OKF-0002", "OKF-0003"]);
  assert.equal(r.redirected, true);
});

test("a superseded document with no approved successor resolves to nothing", () => {
  const docs = new Map([
    ["A", { id: "A", status: "superseded", superseded_by: "B" }],
    ["B", { id: "B", status: "draft" }],
  ]);
  assert.equal(resolveSuperseded(docs.get("A"), (id) => docs.get(id)).doc, null);
  assert.equal(resolveSuperseded({ id: "Z", status: "deprecated" }, () => null).doc, null);
});

test("a supersession cycle terminates", () => {
  const docs = new Map([
    ["A", { id: "A", status: "superseded", superseded_by: "B" }],
    ["B", { id: "B", status: "superseded", superseded_by: "A" }],
  ]);
  assert.equal(resolveSuperseded(docs.get("A"), (id) => docs.get(id)).doc, null);
});

test("an approved document is returned as is", () => {
  const r = resolveSuperseded({ id: "A", status: "approved" }, () => null);
  assert.equal(r.doc.id, "A");
  assert.equal(r.redirected, false);
});

test("docPrecedence ranks a delivered document above its proposal, on the shared kind ranks", () => {
  const { KINDS } = require("../../src/copilot/rag/docPrecedence");
  for (const k of KINDS) assert.equal(k.rank, KIND_RANK[k.kind], k.kind);
  const m = standingMap([
    { name: "Proposal - Oyaara.pdf", summary: "A proposal dated 10 August 2026" },
    { name: "As-built completion report.pdf", summary: "Delivery report dated 20 October 2026" },
  ]);
  assert.ok(m.get("As-built completion report.pdf").order > m.get("Proposal - Oyaara.pdf").order);
});

test("the answer prompt tells the model to name the canonical specification when it contradicts the talk", () => {
  const p = buildSystemPrompt({ deliverable: "quick_answer" });
  assert.match(p, /CANONICAL SPECIFICATION/);
  assert.match(p, /name (the )?(canonical )?(specification|document)|say it is the canonical/i);
});

const { createOkfRouter } = require("../../src/copilot/core/okf/router");
function fakeRegistry(docs) {
  const byId = new Map(docs.map((x) => [x.id, x]));
  return {
    hasBundle: () => true,
    getDocumentById: (id) => byId.get(id) ?? null,
    lookup: (q) =>
      docs.filter((x) => q.toUpperCase().includes(x.id)).map((x) => ({ ...x, matchScore: 1 })),
  };
}
const route = (registry, query) => createOkfRouter().classifyQuery({ query, spec: {}, registry });

test("router: a question naming a superseded OKF id is routed to its approved successor", () => {
  const reg = fakeRegistry([
    { id: "OKF-0001", status: "superseded", superseded_by: "OKF-0003", version: "1.0.0" },
    { id: "OKF-0003", status: "approved", version: "2.0.0" },
  ]);
  const r = route(reg, "what is the official architecture in OKF-0001");
  assert.deepEqual(r.matched_doc_ids, ["OKF-0003"]);
  assert.ok(r.matched_signals.includes("redirect:OKF-0001->OKF-0003"));
});

test("router: a draft or deprecated document with no successor is not treated as canonical", () => {
  const reg = fakeRegistry([
    { id: "OKF-0004", status: "draft", version: "1.0.0" },
    { id: "OKF-0005", status: "deprecated", version: "1.0.0" },
  ]);
  assert.deepEqual(route(reg, "official spec OKF-0004 OKF-0005").matched_doc_ids, []);
});

test("router: several matches come back best first by precedence", () => {
  const reg = fakeRegistry([
    { id: "OKF-0001", status: "approved", version: "1.0.0" },
    { id: "OKF-0002", status: "approved", version: "2.0.0" },
  ]);
  assert.deepEqual(route(reg, "official spec OKF-0001 OKF-0002").matched_doc_ids, [
    "OKF-0002",
    "OKF-0001",
  ]);
});

// Phase 5.5: a malformed version in the data must never take an answer down.
const {
  resolvePrecedence,
  compareSemVer: strictCompare,
} = require("../../src/copilot/core/okf/versionResolver");

test("resolvePrecedence ignores a malformed version instead of throwing", () => {
  const cands = [
    { id: "a", version: "banana", status: "approved" },
    { id: "b", version: "1.2.0", status: "approved" },
    { id: "c", version: "1.10.0", status: "approved" },
  ];
  let res;
  assert.doesNotThrow(() => (res = resolvePrecedence(cands, {})));
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.id, "c");
});

test("resolvePrecedence copes with malformed versions among drafts, deprecated and superseded", () => {
  assert.doesNotThrow(() =>
    resolvePrecedence(
      [
        { id: "a", version: "x", status: "draft" },
        { id: "b", version: "1.0.0", status: "draft" },
      ],
      { allowDraft: true }
    )
  );
  assert.doesNotThrow(() =>
    resolvePrecedence(
      [
        { id: "a", version: "x", status: "deprecated" },
        { id: "b", version: "?", status: "deprecated" },
      ],
      { allowDeprecated: true }
    )
  );
  assert.doesNotThrow(() =>
    resolvePrecedence(
      [
        { id: "a", version: "x", status: "superseded", superseded_by: "q" },
        { id: "b", version: "1.0.0", status: "superseded", superseded_by: "q" },
      ],
      {}
    )
  );
});

test("the strict comparison is unchanged for callers that want the error", () => {
  assert.throws(() => strictCompare("banana", "1.0.0"));
});
