const test = require("node:test");
const assert = require("node:assert/strict");
const { matchProject, rulesFromEvent } = require("../../src/copilot/main/projectMatch");

const ev = {
  summary: "Acme weekly sync",
  hangout_link: "https://meet.google.com/abc-defg-hij",
  organizer_email: "jane@acme.com",
};
const rules = [
  { project_id: 1, kind: "domain", pattern: "acme.com" },
  { project_id: 2, kind: "title", pattern: "weekly sync" },
  { project_id: 3, kind: "meet_url", pattern: "meet.google.com/abc-defg-hij" },
];

test("the strongest rule wins: link over title over domain", () => {
  assert.equal(matchProject(ev, rules), 3);
  assert.equal(matchProject(ev, rules.slice(0, 2)), 2);
  assert.equal(matchProject(ev, rules.slice(0, 1)), 1);
});

test("no event, no rules or no match is no project", () => {
  assert.equal(matchProject(null, rules), null);
  assert.equal(matchProject(ev, []), null);
  assert.equal(matchProject({ summary: "Lunch" }, rules), null);
});

test("conference data links count", () => {
  const e = {
    summary: "x",
    conference_data: JSON.stringify({ entryPoints: [{ uri: "https://zoom.us/j/123" }] }),
  };
  assert.equal(matchProject(e, [{ project_id: 9, kind: "meet_url", pattern: "zoom.us/j/123" }]), 9);
});

test("remembering a manual pick uses the link, else the title", () => {
  assert.deepEqual(rulesFromEvent(ev), [
    { kind: "meet_url", pattern: "meet.google.com/abc-defg-hij" },
  ]);
  assert.deepEqual(rulesFromEvent({ summary: "Board call" }), [
    { kind: "title", pattern: "Board call" },
  ]);
  assert.deepEqual(rulesFromEvent(null), []);
});
