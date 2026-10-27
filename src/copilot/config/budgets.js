// Character budgets (about 4 per token) for each part of the main model's context pack.
// One place to tune; the builder cuts each part to its cap, oldest transcript first.
const ANSWER_BUDGET = {
  meeting: 300,
  summary: 2000,
  transcript: 3500, // newest lines kept
  thread: 2400, // earlier cards of this thread, newest kept
  focus: 800,
  instructions: 1200,
  behavior: 900, // the learned behaviour guide
  plan: 1500,
  reference: 4000, // project files not indexed yet, inlined (first part of each)
  catalog: 1800, // what each indexed project file holds
  passages: 8000, // matching pieces of the project files (the search caps its own: 2800 fast, 7000 high effort)
};

// Output caps per tier. The fast tier is short on purpose: a card is read in seconds mid-meeting.
const ANSWER_LIMITS = {
  fast: { maxTokens: 320, reasoning: { effort: "low" }, timeoutMs: 30000 },
  // The "Go deeper" re-run: a stronger model with web search, still short (bullets), a little thinking allowed.
  deep: { maxTokens: 1200, reasoning: { effort: "low" }, timeoutMs: 60000 },
  reasoning: { maxTokens: 4000, reasoning: null, timeoutMs: 90000 }, // null = the model's own default effort; the cap includes thinking tokens
};

// Thinking tokens count against max_tokens and delay the first word. DeepSeek can think less (or not at all);
// for the fast tier it must not think: 450 tokens were eaten by reasoning (cards cut off) and low effort still took ~10 s.
// Models with mandatory reasoning (Claude) keep a low effort.
const fastReasoningFor = (model) =>
  /deepseek|qwen/i.test(model ?? "") ? { enabled: false } : ANSWER_LIMITS.fast.reasoning;

module.exports = { ANSWER_BUDGET, ANSWER_LIMITS, fastReasoningFor };
