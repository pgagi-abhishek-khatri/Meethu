// The questions asked of D1: ONE call per decision, a handful of questions. Everything else (how to
// answer, what to look up) is the main model's job once a card is worth making.
//   act                 does new_text carry substance about the subject?
//   chatter             is it only small talk or running the meeting?
//   help                is someone asking, unsure, or claiming something worth checking? (card score = act x (1 - chatter) x help)
//   asked_of_assistant  did the USER ask the assistant outright?
//   complete            is the last utterance a finished thought?
//   relation            (only with cards or running analyses) new need / already covered / replaces a job
//   kind                what to show
//   needs_*             what to gather (only the capabilities that are on)
// Anything the code knows exactly (switches, cooldowns, job ids) is never asked.
const { clip, oneLine } = require("./buildState");

const noul = (instructions) => ({ type: "noul", instructions });
const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });

// Ids come from our own stores, but they end up as option names the model sees.
const safeId = (id) =>
  String(id)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 24);

// Order and wording measured on 461 labelled cards: the model picked talking_points for half of them when it
// was the first-listed "something for the USER to say"; explanation first, as the default for a speaker who is
// only describing something, lifted kind agreement from 40% to 85%.
const KINDS = {
  explanation:
    "Explains a term, product, feature, process or concept mentioned in new_text. The default when someone is describing or discussing something.",
  quick_answer:
    "Answers a question that was asked, or checks whether a stated fact, number, rule or claim is right.",
  talking_points:
    "Words for the USER to say. ONLY when someone asks the USER directly for their own opinion, answer or decision, using you, your or the USER's name.",
  diagram: "A diagram that beats words: a process, relationships, a comparison or a timeline.",
  document:
    "The USER asks to draft or write something: an email, write-up, minutes, plan or action items.",
};

const ASKED = noul(
  "Did the USER explicitly ask the assistant to look something up, check, explain, summarize or draft it?"
);

function buildQuestions(ctx) {
  const s = ctx.settings;
  const questions = {};
  const plan = { relation: {}, kinds: [], needs: [], askedRelation: false };

  if (ctx.running?.length || ctx.hasCards) {
    plan.relation.new = { kind: "new" };
    plan.relation.covered = { kind: "covered" };
    const options = {
      new: "A need that no card or running analysis covers yet.",
      covered: "Already covered by a card or running analysis, even if worded differently.",
    };
    for (const job of ctx.running ?? []) {
      const id = safeId(job.id);
      options[`replace_${id}`] =
        `Changes what "${clip(oneLine(job.topic), 50)}" was asked: redo it.`;
      plan.relation[`replace_${id}`] = { kind: "supersede", jobId: job.id };
    }
    plan.askedRelation = true;
    questions.relation = choice(
      "How does new_text relate to the cards and running analyses?",
      options
    );
  }

  // Inside the card cooldown with an analysis running only two things can still matter.
  if (ctx.updateCheck) {
    questions.asked_of_assistant = ASKED;
    return { questions, plan };
  }

  // Measured on 642 labelled real-meeting moments (scratch bench): one broad "is there substance" question
  // plus a separate "is it only chatter" question, multiplied in interpret(), beat one long yes/no list
  // (AUC 0.98 vs 0.86). Narrow per-type questions (question? term? decision?) scored worse.
  questions.act = noul(
    "Does new_text say something substantive about the meeting's subject: a question, fact, number, rule, requirement, plan, feature, process step, claim, term, decision, or a request to check or look something up? NO if it is only small talk, acknowledgements, running the meeting, a vague or rhetorical question, or a fragment too cut off to mean anything."
  );
  questions.chatter = noul(
    "Is new_text only small talk, greetings, thanks, acknowledgements, filler, or running the meeting itself (introductions, agenda, screen sharing, audio checks)?"
  );
  // Measured on 120 written snippets (62 want a card, 58 should stay silent): act x (1 - chatter) alone separates them
  // with AUC 0.83 (speakers using terms they know, decisions and scheduling all look "substantive"); times this
  // question 0.94, and at the bar every wanted card still runs while false runs fall from 33 to 7 of 58.
  questions.help = noul(
    "Is someone in new_text asking a question, unsure about something, or stating a fact, number or claim that is worth checking? NO if the speakers are simply using terms they clearly know, announcing decisions, planning, scheduling or giving updates."
  );
  questions.asked_of_assistant = ASKED;
  questions.complete = noul("Is the last utterance a finished thought, not cut off mid-sentence?");

  const kinds = { ...KINDS };
  if (!s.diagrams) delete kinds.diagram;
  if (!s.documents) delete kinds.document;
  plan.kinds = Object.keys(kinds);
  questions.kind = choice("Which card helps most with new_text?", kinds);

  const needs = [
    [
      s.web,
      "needs_web",
      "web",
      "Does new_text rely on a fact about the outside world (a statistic, price, law, regulation, company, product, person or current event) that could be wrong and could be checked online?",
    ],
    [
      s.projectFiles,
      "needs_project",
      "project",
      "Could the USER's project files (listed in project_files) contain facts that answer or inform new_text: the product, its flows, rules, numbers, names, plans, prices, contracts?",
    ],
    [
      s.pastMeetings,
      "needs_past_meetings",
      "pastMeetings",
      "Does it depend on what was said or decided in an earlier meeting?",
    ],
    [
      s.screenshot,
      "needs_screenshot",
      "screenshot",
      "Is something on the USER's screen essential, such as a slide, chart or code that new_text points at ('as you can see', 'this number')?",
    ],
  ];
  for (const [on, name, key, text] of needs) {
    if (!on) continue;
    questions[name] = noul(text);
    plan.needs.push({ name, key });
  }
  return { questions, plan };
}

module.exports = { buildQuestions, KINDS };
