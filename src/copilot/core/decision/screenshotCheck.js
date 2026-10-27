// Second look, only after the decision asked for a screenshot and one was taken:
// D1 (paid model, image input) judges the picture BEFORE it goes to the main
// model, which may be a cloud model. Fails closed: any doubt means "do not attach".
const { buildDecisionState } = require("./buildState");

const SCREENSHOT_LIMITS = { relevantMin: 0.6, sensitiveMax: 0.4 };

function buildScreenshotCheck(input, imageDataUrl, cfg) {
  return {
    state: buildDecisionState(input, {
      ...cfg,
      maxContextTurns: 1,
      budget: { ...cfg.budget, context: 200, summary: 200 },
    }),
    images: [imageDataUrl],
    questions: {
      image_relevant: {
        type: "noul",
        instructions:
          "Does the image show something that new_text refers to or that would clearly help respond to it, such as a slide, a document, a chart, code or a shared page?",
      },
      image_sensitive: {
        type: "noul",
        instructions:
          "Does the image show private information that should not be sent to a cloud service, such as passwords, banking or card details, private messages, medical data or personal documents?",
      },
    },
  };
}

function interpretScreenshotCheck(answers, limits = SCREENSHOT_LIMITS) {
  const relevant = answers?.image_relevant?.noul;
  const sensitive = answers?.image_sensitive?.noul;
  if (typeof relevant !== "number" || typeof sensitive !== "number")
    return { attach: false, reason: "invalid_answer" };
  if (sensitive > limits.sensitiveMax)
    return { attach: false, reason: `sensitive ${Math.round(sensitive * 100)}%` };
  if (relevant < limits.relevantMin)
    return { attach: false, reason: `not relevant ${Math.round(relevant * 100)}%` };
  return {
    attach: true,
    reason: `relevant ${Math.round(relevant * 100)}%, sensitive ${Math.round(sensitive * 100)}%`,
  };
}

module.exports = { buildScreenshotCheck, interpretScreenshotCheck, SCREENSHOT_LIMITS };
