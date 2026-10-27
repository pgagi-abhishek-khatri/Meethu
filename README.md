# Meethu

Voice dictation, meeting transcription and a **live meeting copilot** for the desktop (macOS, Windows, Linux).

Meethu is a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT). Everything OpenWhispr does — local and cloud speech-to-text, AI dictation agents, notes, meeting transcription — is kept. Meethu adds:

- **Live Meeting Copilot** (`src/copilot`, `src/components/copilot`): listens to a meeting recording and shows short, speakable help cards in its own always-on-top window, with a skipped-moments list, high-effort reruns, learned behaviour guide and project-file search (RAG). Design docs in [`docs/copilot/`](docs/copilot/).
- **Soniox realtime STT** (BYOK) for dictation and meetings.

## Run it

Node 24 (see `.nvmrc`).

```bash
npm ci
npm run dev
npm test
npm run typecheck
```

Copilot needs an OpenRouter API key (Settings → Copilot). See [`docs/copilot/DEV_HARNESS.md`](docs/copilot/DEV_HARNESS.md) for the test harness.

## Upstream

Original project and docs: [OpenWhispr](https://github.com/OpenWhispr/openwhispr) · [README](docs/OPENWHISPR_README.md) · [CLAUDE.md](CLAUDE.md) (architecture reference).

To pull upstream changes later:

```bash
git remote add upstream https://github.com/OpenWhispr/openwhispr.git   # once
git fetch upstream && git merge upstream/main
```

## License

MIT. Original copyright © OpenWhispr Team; see [LICENSE](LICENSE).
