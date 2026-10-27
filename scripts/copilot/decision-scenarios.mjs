// Shared by decision-probe.mjs and decision-eval.mjs. Each scenario: a meeting moment plus a
// machine-checkable expectation (what a sensible human would want the assistant to do).
export const NOW = Date.now();
const seg = (id, source, text, agoS, speaker) => ({
  id,
  source,
  text,
  speaker,
  at: NOW - agoS * 1000,
  final: true,
});

export const base = {
  now: NOW,
  meeting: { title: "Q3 planning with Acme", type: "client call" },
  summary: "Acme wants to expand to Europe next quarter. Discussing budget and timeline.",
  settings: {
    quiet: "normal",
    web: true,
    projectFiles: true,
    screenshot: true,
    diagrams: true,
    documents: true,
  },
  signals: { endpoint: true, sinceLastCardMs: 60000 },
};
const talk = [
  seg(1, "system", "Thanks for joining everyone.", 90, "system:1"),
  seg(2, "mic", "Happy to be here, let's get started.", 80),
];
const other = (text, extra = {}) => ({
  transcript: [...talk, seg(3, "system", text, 4, "system:1")],
  newFromId: 3,
  ...extra,
});
const user = (text, extra = {}) => ({
  transcript: [...talk, seg(3, "mic", text, 3)],
  newFromId: 3,
  ...extra,
});

const quiet = (o) => o.kind === "wait" || o.kind === "skip";
const runs = (o) => o.kind === "run";

// [name, input overrides, expectation text, check(decision) -> boolean]
export const SCENARIOS = [
  // ---- should act
  [
    "factual question to the user",
    other("Quick one: what was France's GDP last year?"),
    "run + web",
    (o) => runs(o) && o.needs.web,
  ],
  [
    "user asks the assistant",
    user("Copilot, check what the current US Federal Reserve rate is."),
    "run explicit",
    (o) => runs(o) && o.trigger === "explicit",
  ],
  [
    "term used fluently, nobody asks (strict: silent)",
    other("We would structure it as a SAFE note with a valuation cap and a pro rata side letter."),
    "wait",
    quiet,
  ],
  [
    "someone asks the user for input",
    other("Can you walk us through your proposed timeline for the rollout?"),
    "run",
    runs,
  ],
  [
    "narrows a running analysis",
    {
      running: [
        { id: "j1", topic: "France economy overview", status: "generating", startedAt: NOW - 3000 },
      ],
      transcript: [
        ...talk,
        seg(3, "system", "What was France's GDP last year?", 9, "system:1"),
        seg(4, "system", "Sorry, I meant per capita, not total.", 3, "system:1"),
      ],
      newFromId: 4,
    },
    "run + replace j1",
    (o) => runs(o) && o.cancelJobId === "j1",
  ],
  [
    "refers to something on screen",
    other("As you can see on this slide, margin dropped from 32 to 24 percent."),
    "run",
    runs,
  ],
  [
    "user asks for a document",
    user("Copilot, draft a follow-up email with the action items we agreed."),
    "run document",
    (o) => runs(o) && o.deliverable === "document",
  ],
  [
    "process described, nobody asks (strict: silent)",
    other(
      "Approvals go from sales to legal, then finance, then back to the regional director, unless it is over fifty thousand, then the CFO signs."
    ),
    "wait",
    quiet,
  ],
  [
    "topic switch with a thread open",
    other("Separately, who is handling the GDPR data processing agreement?", {
      threads: [{ id: "t1", title: "Europe budget", gist: "headcount and spend for EU launch" }],
    }),
    "run",
    runs,
  ],
  [
    "claim with a number",
    other("Our churn is down to two percent, which is the best in the industry."),
    "run",
    runs,
  ],
  [
    "decision between options",
    other("So should we go with vendor A or vendor B for the data warehouse?"),
    "run",
    runs,
  ],
  [
    "asks about a person/company",
    other(
      "Has anyone looked into whether Northwind Capital is actually still investing in Europe?"
    ),
    "run + web",
    (o) => runs(o) && o.needs.web,
  ],
  // ---- should stay quiet
  ["small talk", other("Great, good to see you all again, how was the weekend?"), "quiet", quiet],
  ["agreement", other("Yeah, sounds good to me."), "quiet", quiet],
  ["acknowledgement", other("Okay, right, that makes sense."), "quiet", quiet],
  ["user narrates own action", user("Let me share my screen in a second."), "quiet", quiet],
  ["mute problem", other("Sorry, you're on mute."), "quiet", quiet],
  ["goodbye", other("Thanks everyone, talk to you next week."), "quiet", quiet],
  [
    "introduction",
    other("Hi, I'm Mark from the finance team, I'll be joining for the budget part."),
    "quiet",
    quiet,
  ],
  ["logistics question", other("Can everyone hear me okay?"), "quiet", quiet],
  ["brief pause", user("Let me grab some water, one sec."), "quiet", quiet],
  [
    "already answered by a card",
    other("So France is roughly three trillion euros then.", {
      recentCards: [
        {
          kind: "quick_answer",
          gist: "France GDP 2024 was about 3.1 trillion euros",
          shownAt: NOW - 25000,
          reaction: "pinned",
        },
      ],
    }),
    "quiet",
    quiet,
  ],
  // ---- should wait for more
  [
    "sentence unfinished",
    other("So what we really need to decide today is whether we", {
      signals: { endpoint: false, waitedMs: 0 },
    }),
    "recheck or wait (never run)",
    (o) => o.kind === "recheck" || o.kind === "wait",
  ],
];
