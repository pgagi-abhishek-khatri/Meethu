// Which project a meeting belongs to, from the calendar event it is linked to. Pure.
// A project owns rules: `meet_url` (part of the Meet/Zoom link), `title` (part of the event title) and
// `domain` (the organizer's or an attendee's email domain). The strongest matching rule wins.
const SCORE = { meet_url: 3, title: 2, domain: 1 };

function linksOf(event) {
  const links = [event?.hangout_link];
  try {
    const data =
      typeof event?.conference_data === "string"
        ? JSON.parse(event.conference_data)
        : event?.conference_data;
    for (const e of data?.entryPoints ?? []) links.push(e?.uri);
  } catch {}
  return links.filter(Boolean).map(String);
}

const domainOf = (email) =>
  String(email ?? "")
    .split("@")[1]
    ?.trim()
    .toLowerCase() ?? "";

function matchProject(event, rules) {
  if (!event || !rules?.length) return null;
  const title = String(event.summary ?? "").toLowerCase();
  const links = linksOf(event).map((l) => l.toLowerCase());
  const domains = new Set([domainOf(event.organizer_email)].filter(Boolean));
  let best = null;
  for (const r of rules) {
    const p = String(r.pattern ?? "")
      .trim()
      .toLowerCase();
    if (!p) continue;
    const hit =
      r.kind === "title"
        ? title.includes(p)
        : r.kind === "meet_url"
          ? links.some((l) => l.includes(p))
          : r.kind === "domain"
            ? domains.has(p.replace(/^@/, ""))
            : false;
    const score = SCORE[r.kind] ?? 0;
    if (hit && (!best || score > best.score || (score === best.score && r.project_id < best.id)))
      best = { id: r.project_id, score };
  }
  return best?.id ?? null;
}

// What to remember when the user picks a project by hand for this meeting: the link if there is one
// (a recurring call keeps its link), else the title.
function rulesFromEvent(event) {
  if (!event) return [];
  const link = linksOf(event)[0];
  if (link) return [{ kind: "meet_url", pattern: link.replace(/^https?:\/\//, "").split("?")[0] }];
  const title = String(event.summary ?? "").trim();
  return title ? [{ kind: "title", pattern: title }] : [];
}

module.exports = { matchProject, rulesFromEvent };
