const test = require("node:test");
const assert = require("node:assert/strict");
const {
  docStanding,
  precedenceOrder,
  precedenceNote,
  standingMap,
  findDate,
} = require("../../src/copilot/rag/docPrecedence");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { rrf } = require("../../src/copilot/rag/vectors");

// The CarZilla files as the indexer saved them (name + brief from the profile).
const CARZILLA = [
  {
    name: "CarZilla Proposal.pdf",
    profile: {
      brief:
        "Technical and implementation proposal by PG-AGI for CarZilla's production online vehicle auction platform, prepared in August 2026.",
    },
    summary: "PG-AGI's August 2026 technical implementation proposal ...",
  },
  {
    name: "CarZilla_Project_Completion_Document.pdf",
    profile: {
      brief:
        "Project completion document by PG-AGI detailing the CarZilla UAE vehicle auction platform, dated 28 September 2026.",
    },
  },
  {
    name: "CarZilla_Feature_Completion_Document_Phase_2_.pdf",
    profile: {
      brief:
        "Project completion document by PG-AGI detailing phase 2 features for the CarZilla Auction Web Platform, dated 14 October 2026.",
    },
  },
  { name: "pricing.md", summary: "Plans and prices." },
];

test("docStanding: kind, date and phase come from the name and the brief", () => {
  const [p, c1, c2, other] = CARZILLA.map(docStanding);
  assert.equal(p.kind, "proposal");
  assert.equal(p.dateText, "Aug 2026");
  assert.equal(c1.kind, "built");
  assert.equal(c1.dateText, "28 Sep 2026");
  assert.equal(c2.kind, "built");
  assert.equal(c2.phase, 2);
  assert.equal(other.kind, "other");
  assert.equal(other.rank, null);
});

test("precedenceOrder: what was built beats the plan, the later build beats the earlier, others are left out", () => {
  assert.deepEqual(
    precedenceOrder(CARZILLA).map((s) => s.name),
    [
      "CarZilla_Feature_Completion_Document_Phase_2_.pdf",
      "CarZilla_Project_Completion_Document.pdf",
      "CarZilla Proposal.pdf",
    ]
  );
  const note = precedenceNote([...standingMap(CARZILLA).values()]);
  assert.match(note, /1\. CarZilla_Feature_Completion_Document_Phase_2_\.pdf/);
  assert.match(note, /3\. CarZilla Proposal\.pdf \(original plan, Aug 2026\)/);
  assert.match(note, /only replaces the points it covers/);
  assert.equal(precedenceNote([...standingMap([CARZILLA[0], CARZILLA[3]]).values()]), "");
});

test("findDate: day-month-year, month-day-year, month-year and ISO", () => {
  assert.equal(findDate("dated 14 October 2026").t, Date.UTC(2026, 9, 14));
  assert.equal(findDate("on October 14, 2026").t, Date.UTC(2026, 9, 14));
  assert.equal(findDate("prepared in August 2026").t, Date.UTC(2026, 7, 1));
  assert.equal(findDate("v1 2026-09-28").t, Date.UTC(2026, 8, 28));
  assert.equal(findDate("no date here"), null);
});

// A search where only the proposal's passage matched at first: the completion document's best match on the same
// point is shown too, first, with each passage labelled and the note saying which wins.
test("retrieve: a newer document's passage joins an older one's, comes first, and the note says which wins", async () => {
  const chunks = {
    1: { file: "CarZilla Proposal.pdf", text: "Admin roles: five roles A B C D E.", vec: [1, 0] },
    2: {
      file: "CarZilla_Feature_Completion_Document_Phase_2_.pdf",
      text: "Staff roles: Sales, Finance, Support, Inspector, Auction BRO.",
      vec: [0.6, 0.8],
    },
    3: { file: "pricing.md", text: "Unrelated prices.", vec: [0, 1] },
  };
  const rag = {
    hasIndex: () => true,
    catalog: () => CARZILLA,
    keyword: () => [],
    vector: (_p, vec) =>
      Object.entries(chunks)
        .map(([id, c]) => ({ id: Number(id), score: c.vec[0] * vec[0] + c.vec[1] * vec[1] }))
        .sort((a, b) => b.score - a.score),
    chunk: (id) => ({ id, file: chunks[id].file, text: chunks[id].text, meta: {} }),
    rrf,
  };
  const clients = () => ({
    embed: { embedQueries: async (qs) => ({ vectors: qs.map(() => [1, 0]), cost: 0 }) },
  });
  // floor 0.58: the phase 2 passage (0.6) is under the proposal's best (1.0) by more than the margin
  const r = createRetriever({ rag, clients });
  const out = await r.retrieve({ query: "how many admin roles", projectIds: [1] });
  assert.deepEqual(
    out.used.map((u) => u.file),
    ["CarZilla_Feature_Completion_Document_Phase_2_.pdf", "CarZilla Proposal.pdf"]
  );
  assert.equal(out.used[0].addedNewer, true);
  assert.match(out.text, /Most trusted first: 1\. CarZilla_Feature_Completion/);
  assert.match(out.text, /\[CarZilla Proposal\.pdf · original plan, Aug 2026\]/);
  assert.match(out.text, /\[CarZilla_Feature_Completion_Document_Phase_2_\.pdf · phase 2, what was built, 14 Oct 2026\]/);
  assert.doesNotMatch(out.text, /Unrelated prices/);
  // the catalog the answer model always gets carries the same order
  assert.match(r.catalog([1]), /Most trusted first/);
});
