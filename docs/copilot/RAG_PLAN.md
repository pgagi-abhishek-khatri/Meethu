# Copilot RAG: project files as live meeting context

Goal: a file added to a project is analysed and indexed once, in parallel and fast. During a meeting the copilot
pulls the right pieces into the answer only when the moment needs them, without slowing the card down.

## Facts checked live against OpenRouter (2026-10-14, real calls with the project key)

| Thing | Result |
|---|---|
| `google/gemini-embedding-2` | `POST /api/v1/embeddings`, 8192 token input, default 3072 dims, **`dimensions` works** (768 tested), no `task_type` param |
| Batch | **max 100 inputs per request** (250 fails with 400) |
| Text price | $0.20 / 1M tokens (a 700-char chunk ≈ 170 tokens = $0.00003) |
| Image | `image_url` data URL, 258 tokens, ~$0.0001; text + image in one input gives one joint vector |
| Audio | `input_audio` with a **data URL** (`data:audio/mpeg;base64,...`), 25 tokens/s, $6.5/1M tokens, works up to 175 s, **fails at 200 s** (cap ≈ 180 s) |
| Video | `input_video` data URL (mp4), ≈ 66 tokens/s, capped near 120 s (7920 tokens) |
| PDF into the embedder | no accepted shape through OpenRouter (all variants rejected): PDFs are read by the analysis model instead |
| Audio in the chat API | bare base64 (`input_audio.data`), NOT a data URL; the embeddings API wants the data URL |
| Native media embedding cost | video ≈ $0.04 per 40 s (~$4/hour), audio ≈ $6.5/M tokens (25 tok/s ≈ $0.6/hour): hence the 5 min default |
| `google/gemini-3.8-flash` | 1M context, 65k output, $0.75 / $3.75 per 1M (batch variant half price), takes text, image, **PDF (`file`)**, **audio (`input_audio`)**, **video (`video_url`)**; 5 s for a small call |
| Libraries here | `ffmpeg-static` (audio/video), `adm-zip` (docx/pptx/xlsx are zips), `better-sqlite3` (FTS5 built in). No PDF lib: PDFs go whole to Gemini; page-splitting is a later add (`pdf-lib`) |

## Decisions and improvements over the first idea

1. **Vectors live in SQLite next to the project, searched in memory.** 768 dims (Matryoshka cut, re-normalised): 3 KB a chunk,
   10k chunks = 30 MB, a brute-force search is ~5 ms. No Qdrant, no extra process. 3072 dims would be 4x the size for ~1 % quality.
2. **Hybrid search: SQLite FTS5 (keywords) + vectors, merged by rank (RRF).** Product names, people and numbers ("Oyaara", "₹4,999")
   are exactly where embeddings are weakest and keywords are perfect, and FTS costs 1 ms and no network.
3. **The reader needs text.** The cheap answer models cannot hear audio or see video. So every chunk has `text` (what the answer model reads:
   the document passage, or Gemini's transcript / description of that window) and a vector. Audio/video windows are embedded **natively** while
   the project's media budget lasts (setting, default 5 min of audio+video per file, because audio is $6.5/M), after that from the text.
   Both live in one vector space, so a text question finds them either way.
4. **A one-paragraph catalog per file** (what it is, what it contains, when it is useful) is always in the answer prompt (≈ 60 words a file,
   max 12 files). It lets the model know what exists, lets the gate below decide without a call, and costs ~200 tokens.
5. **No query-generation LLM call on the live path.** The question the speaker asked IS the query (plus the previous line when short).
   The embedding of it is started **speculatively while the decider is still running** (D1 takes ~1 s, the embedding ~0.3 s), so
   by the time D1 says "needs the project", the hits are ready and the card is not delayed. "Rerun with high effort" may spend a cheap model
   call to write 2 to 3 sub-queries and takes more chunks.
6. **When the context search runs (speed):** only if (a) the project has indexed files and (b) D1's `needs_project` is on, or the user typed the
   question, or it is a high-effort rerun; never for a plain definition and never when the moment is web-only. FTS runs first (free);
   the embedding call is skipped when FTS already finds a strong match for an exact term and the question is short. A relevance floor drops
   weak hits: nothing is better than wrong context, and the card then says nothing about the files.
7. **Ingest is a parallel pipeline**, one job per file, a global pool (default 4 embedding calls, 3 analysis calls) so five files at once do not
   queue behind each other. Stages: read/transcode → split → (analyse ‖ embed) → save. Embeddings are cached by content hash, so a changed file
   re-embeds only the changed chunks and the same file in two projects is free.
8. **Everything is logged** (below) so a miss can be traced from the question to the chunk.

## What happens to each file type

| Type | Read by | Chunks | Embedded as | Limit |
|---|---|---|---|---|
| txt md csv tsv json html xml log yaml | read locally | ~900 chars, split on headings/paragraphs, 120 overlap, heading kept on each chunk | text | 5 MB, first 1.2M chars |
| pdf | Gemini 3.8 Flash (`file`) → markdown, scans/OCR included | as text, by heading | text | 25 MB, output cap 64k tokens (≈100–150 pages; more is cut and flagged "partial") |
| docx pptx xlsx | `adm-zip` + XML text extraction, local | as text (slide / sheet = section) | text | 25 MB |
| image png jpg webp gif | Gemini describes it and reads any text on it | 1 chunk: description + OCR | text + image together (one vector) | 10 MB |
| audio mp3 wav m4a ogg flac | ffmpeg → 16 kHz mono mp3; Gemini transcribes with timestamps in 10 min parts, in parallel | 60 s windows, 10 s overlap | native audio while the media budget lasts, else the window's transcript | 150 MB, 3 h |
| video mp4 mov webm mkv | ffmpeg → 480p/2 fps + mono audio; Gemini describes + transcribes in 10 min parts | 30 s windows | native video while the media budget lasts, else text | 300 MB, 60 min |
| anything else | not indexed; shown as "unsupported" with the reason | | | |

Per project: 1 GB of files, 20,000 chunks. Over a limit → the file stays listed with a red reason, nothing silently dropped.
Summaries: text kinds summarised from the headings plus the first ~50k chars; media from the transcript; always ≤ 80 words.

## Retrieval in a meeting

```
speaker line --> scheduler --> D1 (needs_project?) -----------+
        \--> speculative: embed(query) + FTS(query) ----------+--> merge (RRF) --> floor --> top K
                                                                                          |
main model prompt = instructions + notes + CATALOG + CONTEXT CHUNKS (named, with page/time) + summary + transcript
```

- Fast tier: K = 5, ≤ 2,800 chars. High effort: K = 10 + sub-queries, ≤ 7,000 chars, Claude.
- Each chunk is shown to the model as `[file · page/time] text`; the model is told to say where a fact came from in plain words
  ("from the pricing sheet"), never a path.
- The card footer shows the files used (tappable later).

## Logging (`copilot-rag.jsonl` in userData, plus the debug log)

- `ingest`: file, kind, stage (read, split, analyse, embed, save), ms, tokens, cost, chunk count, any error or cut.
- `retrieve`: question (clipped), mode (fts/vector/hybrid/skipped + reason), embed ms, search ms, candidates, kept with score and file, injected chars.
- `gate`: why retrieval was skipped (no files, web-only, definition, below floor).
- Session cost counters (embed tokens, analysis tokens) in the stats event.

## Build order

1. `src/copilot/rag/` pure modules + tests: limits, chunker, embedding client (batching, retry, cache), vector math + RRF, gate.
2. Store: `copilot_docs`, `copilot_chunks`, FTS5 table; hybrid search; tests.
3. Ingest pipeline: text/docx first, then pdf/image, then audio/video (ffmpeg).
4. Engine: catalog + retrieval wired into the answer path, speculative embed, deep sub-queries; `needs.project` becomes live.
5. UI: file rows with status (queued / reading / embedding / ready / error), per-file summary, size/limit messages, "retry".
6. Test on the real files you share (Oyaara) with the saved meetings: replay, check that the chunks come back, tune the floor and K.
7. Full code re-read, then the checks (unit, electron DB, tsc, build).

## Status (2026-10-14): built and checked

- Modules: `src/copilot/rag/` (config, chunker, vectors, openrouter, embedClient, analyzeClient, extract, media, ragStore, ingest, retrieve, ragLog). Engine hook `rag`, answer runner `prepare`, service wiring, Copilot page file rows (status, summary, retry), Settings > Copilot > Project files.
- Live check with the real key on 6 sample files (md, docx, png, pdf, mp3, mp4): all indexed in 15-20 s together; relevant questions returned the right passage first (cosine 0.70-0.78), an unrelated one ("capital of France") returned nothing; a search costs ~1.0-1.1 s, nearly all of it the query embedding (hidden when D1 triggered it, because the embedding starts while D1 runs).
- Measured relevance: relevant 0.60-0.80, unrelated in the same domain 0.48-0.60, so floor 0.58 and a margin of 0.08 under the best; an exact keyword hit (FTS5, stop words removed) also keeps a passage.
- Still to do with real material: tune floor/K on the Oyaara files and the saved meetings (`RAG_DIR` replay), speech audio (only tones and test video were available here), PDF page-splitting for very long PDFs (`pdf-lib`), docx images.

## OYaara test (2026-10-14): 16 real files, 4 old meetings replayed

- Indexing (16 files: 2 PDFs of 252 + 48 chunks, 14 infographics): 180 s at first (one 250-chunk PDF read in one call held a slot for 150 s), **83-107 s** after splitting PDFs into 12-page parts read side by side and raising files-at-once to 4. The big PDF alone: 150 s -> 51 s. Cost about $0.22-0.28 for the whole set.
- First replay found the gap: the decider never said "needs the project" (0 of 26 cards). Fixes: the decider now sees a one-line catalog of the files (`project_files`), and an unasked card still looks in the files when something matches closely (cosine >= 0.69, no model call; the query embedding is warmed while the decider runs). Result on the team meeting: 20 of 20 cards searched (9 by the decider, 11 by the close-match rule, 9 other close-match looks rejected as weak), search 2-3 ms when warmed.
- Junk in the index (a heading alone, "Figure: logo") was handed to the model: dropped at indexing. Infographics were summarised in 120 words and lost their detail: now every label and number is written out and split into chunks ("rank badges Bronze to Legend", "Smart Buyer Score" found).
- Correctness spot checks: a tapped Skipped item "four tasks ... each task has some points" answered Watch 5 / Attendance 2 / Add friend 25 / Add supplier 40, which matches the rewards sheet (10+15, 20+20). "Are we building USSD?" returned the addendum's "As agreed, we are not building USSD".
- Fast vs high effort on the same moment: fast 0.55-0.68 s, 4 short bullets; high effort 6.4-8.7 s, 8 bullets citing project facts (Integrity 80 / Trust 70, Bronze to Legend, 1,500-point vouchers) and a different recommendation.
- Fewer decider calls: after 6 empty decisions in a row the calls are spaced 3x wider (a real question still goes at once), and "...right?" tags no longer count as questions. Same 25-minute meeting: 170 -> 114 calls, 1.00M -> 0.67M input tokens.
- Summary: one call per 15 new messages (no timer); models read the last 15 messages verbatim plus the summary of older ones.
