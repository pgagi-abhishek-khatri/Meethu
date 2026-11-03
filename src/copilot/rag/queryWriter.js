// Turns a noisy meeting moment into a few short search queries for the project files. Runs on every card that
// searches the files, beside the raw-moment embedding, so a slow or failed call only costs the extra queries.
// A fast instruct model with thinking off: the output is three short lines, and every token of thought is wait.
const { postJson } = require("./openrouter");
const { RAG } = require("./config");

const SYSTEM =
  "You write search queries for the USER's own project documents. From the meeting moment, work out the exact fact the documents must hold, and write up to 3 short queries (each at most 12 words). The first restates the precise question with every name, number, amount and term from the moment (write numbers as digits, e.g. 32,000). The others use the words a document would use for that same fact (a section title, a table heading, a feature name). Stay specific: never a broad query like 'bidding rules' or 'project overview'. Ignore filler, greetings and who is speaking. If nothing in the moment could be in the documents, write NONE. One query per line, nothing else.";

const lines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s"]+|"$/g, "").trim())
    .filter((l) => l && l.length <= 160 && !/^\(|^none\b/i.test(l));

// moment: the new transcript lines; catalog: what the files are (gives the model the documents' own words).
const userText = ({ moment, gist = "", catalog = "" }) =>
  [
    catalog && `Project files:\n${catalog}`,
    `Meeting moment:\n${moment}`,
    gist && gist !== moment && `What it is about: ${gist}`,
  ]
    .filter(Boolean)
    .join("\n\n");

function createQueryWriter({
  apiKey,
  model = RAG.queryModel,
  timeoutMs = RAG.queryTimeoutMs,
  baseUrl,
  fetchImpl,
}) {
  // image: an optional screenshot data URL.
  return async function write({ moment, gist = "", catalog = "", image = null, signal }) {
    const user = userText({ moment, gist, catalog });
    const res = await postJson(
      "/chat/completions",
      {
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: image
              ? [
                  { type: "text", text: user },
                  { type: "image_url", image_url: { url: image } },
                ]
              : user,
          },
        ],
        max_tokens: 80,
        temperature: 0,
        reasoning: { enabled: false },
        usage: { include: true },
      },
      { apiKey, baseUrl, fetchImpl, retries: 0, timeoutMs, signal }
    );
    return {
      queries: lines(res.choices?.[0]?.message?.content).slice(0, 3),
      tokens: res.usage?.total_tokens ?? 0,
      cost: Number(res.usage?.cost) || 0,
    };
  };
}

module.exports = { createQueryWriter, SYSTEM, userText };
