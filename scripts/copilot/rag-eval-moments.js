// The labelled moments shared by rag-query-eval.js (runs them) and rag-eval-report.js (writes them up).
// Moments: a few lines of real-sounding talk (filler included), the question the decider would pick, and the fact.
// gold = null: nothing in the files answers it (the unasked look must stay quiet).
const M = (lines, gold) => ({ lines, gold });
const MOMENTS = [
  M(
    [
      "OTHER-1: Okay so before we move on, yeah, I had one more on infra.",
      "OTHER-1: The client's legal team asked where the data physically sits, like which AWS region did we deploy the platform to?",
      "USER: Right, let me think.",
    ],
    /ap-south-1|Mumbai/i
  ),
  M(
    [
      "OTHER-2: So on the bidding screen, hmm, people keep asking us.",
      "OTHER-2: If the current bid on a car is thirty two thousand dirhams, what's the minimum next bid they can place?",
    ],
    /32,500|10,000 to 49,999/
  ),
  M(
    [
      "OTHER-1: Marketing wants to push the referral thing next month.",
      "OTHER-1: How much does someone actually earn when a friend they referred buys a car?",
      "OTHER-1: Is it per car or a one-off?",
    ],
    /AED 100 per car/
  ),
  M(
    [
      "OTHER-3: Yeah I mean load testing, we did some of that, right?",
      "OTHER-3: What throughput did we prove the bidding engine can take on a single lot, bids per second?",
    ],
    /40 bids per second/i
  ),
  M(
    [
      "OTHER-1: Okay, uh, real time stuff.",
      "OTHER-1: What are we using for the cache and the cross-instance fan out for the sockets? Is that Redis?",
    ],
    /Valkey/
  ),
  M(
    [
      "OTHER-2: Cost review, quickly.",
      "OTHER-2: The database, what instance size is the RDS on right now, and how long are backups kept?",
    ],
    /db\.t3\.micro|Backup retention/i
  ),
  M(
    [
      "OTHER-1: From a bidder's side, what do they have to hand over to register?",
      "OTHER-1: Like ID documents, any face check, that kind of thing?",
    ],
    /Emirates ID|liveness/i
  ),
  M(
    [
      "OTHER-2: Payments, sorry, going back to that.",
      "OTHER-2: Which payment provider did we recommend and what were its fees for small volumes?",
    ],
    /2\.69%|AED 149 per month/
  ),
  M(
    [
      "OTHER-1: The owner asked again about the minimum price thing.",
      "OTHER-1: Do bidders ever see the reserve price on a lot or is it hidden?",
    ],
    /hidden from bidders/i
  ),
  M(
    [
      "OTHER-3: For the AI summaries on each lot, the inspection ones.",
      "OTHER-3: How many tokens does that burn per lot, and per month at our volume?",
    ],
    /2,450|637,000/
  ),
  M(
    [
      "OTHER-1: Timeline wise, they're nervous.",
      "OTHER-1: What did we say about delivering in two weeks, what has to be true before day one?",
    ],
    /two-week delivery|two weeks/i
  ),
  M(
    [
      "OTHER-2: Phase two stuff now.",
      "OTHER-2: Can a bidder take back a bid they placed by mistake? How does cancel work in phase two?",
    ],
    /Cancel My Bid|cancel/i
  ),
  M(
    [
      "OTHER-1: The open bidding change, the two day thing.",
      "OTHER-1: Can you remind me how two-day open bidding works?",
    ],
    /Two-Day Open Bidding|two-day/i
  ),
  M(
    [
      "OTHER-2: And the sellers side.",
      "OTHER-2: The feature where an owner lists their own car with us, how does that flow go?",
    ],
    /Sell My Car/i
  ),
  M(
    [
      "OTHER-1: When someone bids in the last few seconds, the clock does something, right?",
      "OTHER-1: What's the anti-sniping rule called and what does it do?",
    ],
    /Golden Closing/i
  ),
  M(
    [
      "OTHER-1: Totally separate, did anyone see the cricket last night?",
      "OTHER-2: Yeah, what a finish.",
    ],
    null
  ),
  M(["OTHER-1: Quick one, what's France's GDP these days, roughly?"], null),
  M(["OTHER-2: Great, good to see everyone, how was the long weekend?"], null),
];

module.exports = { MOMENTS };
