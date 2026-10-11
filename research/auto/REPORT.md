# Auto topic mode — what was built, and who should decide when the bot speaks

*2026-09-25, branch `feat/auto-mode` (forked from `feat/group-use`). The research notes behind the choices are in [landscape.md](landscape.md).*

## The short version

- **Auto is built**, as a fourth Topic mode: ✨ Auto. The bot reads along as in Conversation mode. After people go quiet for a moment, a cheap *judge* decides JOIN or QUIET. Only a JOIN reaches the topic's real model. That turn runs silently, and the model can still decline, in which case nothing appears.
- **The judge is Claude through the CLI by default.** On a 90-case test set:
  - **Sonnet 5** was right 96% of the time with 2 unwanted joins, for about $0.005 per look at list price.
  - **Haiku 4.5** was right 88% of the time with 3 unwanted joins, for about $0.0013. Its misses are mostly cases it should have joined.
  - Neither made an unwanted join on the 63 clear-cut cases.
- **A local model is usable, but not as good as Haiku.** The bridge gives local judges a short few-shot prompt.
  - With it, **Qwen3-4B-Instruct-2507** (Apache-2.0) was right **80%** of the time on all 90 cases. It made 6 unwanted joins, against Haiku's 3, and got all 12 Persian cases right.
  - It took about 6 s a look on this 4-core shared VPS (no GPU), and costs nothing per message.
  - On the 34-case subset it had looked level with Haiku (88%, no unwanted joins); the full set is the honest number. Gemma 4 E2B came in at 73% on the full set. At a stricter threshold (0.7) it made no unwanted joins at all, but caught only 38% of the real openings.
  - With the same full prompt Claude gets, every small model joined far too often: 10–18 unwanted joins out of 22 quiet cases on the subset. The literature reports the same bias.
- **Check this before relying on it for a company:** Anthropic's consumer terms for Pro and Max. See the note at the end, which applies to the whole bridge and not only to the judge.

## What was built

The whole path of an unmentioned message:

1. **Recorded** exactly as in Conversation mode. It arms a timer for the topic only if the sender is allowed to use the bot. Anyone's messages are read as background, but a stranger in the group can't make the bot act. That is the same line a mention draws.
2. **Wait for quiet.** With the `balanced` setting the judge looks 25 s after the last message, and a busy topic waits at most 2 minutes. `reserved` waits 45 s / 3 min and `chatty` 15 s / 1 min. Saying the bot's name without @ looks within 1.5 s.
3. **Free rules first:**
   - A burst of only acknowledgements and emoji ("ok", "👍", "مرسی") is never judged.
   - After the bot has joined on its own, it pauses 15, 5 or 1 minute by eagerness; its name skips the pause.
   - There is a ceiling of 40 looks per topic per hour (`TG_AUTO_MAX_LOOKS_PER_HOUR`).
4. **The judge** sees the topic title, the topic's instructions, and the last 14 messages. What's new is marked, and so is the bot's own last answer, so "thanks!" is not mistaken for a question. It answers JOIN or QUIET; a JOIN comes with a short note on what the bot would add.
   - **Claude:** `claude -p --model haiku|sonnet --system-prompt … --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands` with thinking off, run from a temp directory outside any repo. It can't act, and it leaves no transcript, no auto-memory and no CLAUDE.md in context. About 900–1,200 input tokens and 1 s of API time; 3–4 s including CLI start-up.
   - **Local:** any OpenAI-compatible server (`TG_AUTO_LOCAL_URL`), such as llama.cpp's `llama-server`. It is scored by P(JOIN) from the first token's logprobs against a threshold set by eagerness, and fails closed if the server is missing.
5. **On JOIN**, the topic's own model runs a normal turn in the topic's session with the conversation since its last turn. It shows no status message and no Interrupt button, and is told it was not asked. It may reply `NO_REPLY`, and then nothing is posted. An error is not posted either, since nobody asked. The exchange stays in the session, so a later mention knows what it saw.

**Settings:**
- **Topic mode ✨ Auto** is on the first `/config` screen.
- Under More settings:
  - **Auto: how often it joins** (reserved / balanced / chatty);
  - **Auto: who decides** (Claude Haiku / Claude Sonnet / local model);
  - **Answers** gains "when mentioned, or on its own".
- The server defaults are `TG_AUTO_JUDGE`, `TG_AUTO_EAGERNESS`, `TG_AUTO_LOCAL_URL`, `TG_AUTO_LOCAL_MODEL` and `TG_AUTO_MAX_LOOKS_PER_HOUR`. `TG_AUTO_QUIET_MS` shortens the wait, for testing.

**Logging:** every look logs one `[auto]` line with the verdict, judge, time and note, so decisions can be reviewed and later used as training data.

**Tests:**
- 1 new Tier 3 case on real Telegram (`feature_auto_mode`); it passed. See the open questions.
- 11 new e2e cases on the fake Telegram, the 11th being the local judge through a stand-in model server: JOIN speaks without a status bubble; the judge's exact flags and working directory; QUIET; the model declining; a mention bypassing the judge; strangers can't arm it; acknowledgements are skipped; the pause after joining and the name overriding it; the timer path; the settings.
- 8 new unit tests.
- Full suite: 491 pass, 0 fail (`bun test`); shell tests below.

## Who should judge: the benchmark

The test set is `triage-eval.jsonl`, written for this:

- 90 short group-chat scenarios, each ending at a decision point: 32 JOIN and 58 QUIET.
- 70 English, 12 Persian and 8 mixed.
- 27 borderline.
- 17 categories: addressed by name, open question, task request, factual error, stuck; and on the quiet side a question to a person, social, already answered, decision made, debate, personal, thanks to the bot, talking about the bot, mid-thought, rhetorical, low-value, and injection attempts.

A Claude agent wrote and labelled it, so it may flatter Claude judges. The labels encode "interrupting is worse than silence".

### Claude, all 90 cases

| Judge | Right | JOIN precision | JOIN recall | Unwanted joins | Missed joins | p50 time | List cost / look |
|---|---|---|---|---|---|---|---|
| **Sonnet 5** | **96%** | 94% | 94% | 2 / 58 | 2 / 32 | 3.2 s | $0.0053 |
| **Haiku 4.5** | 88% | 89% | 75% | 3 / 58 | 8 / 32 | 3.4 s | $0.0013 |

- **Clear cases only:** Sonnet 98% and Haiku 90%, with no unwanted joins from either.
- **Persian:** Sonnet 12/12 and Haiku 11/12.
- **Weak spot:** factual mistakes worth correcting (Haiku 1/5, Sonnet 3/5).

### Local models, on a stratified 34-case subset

The subset takes 2 cases per category. Its 11 Persian and 6 mixed cases make it harder than the full set.

- Hardware: 4 vCPU AMD EPYC 7543P (Zen 3, AVX2), shared with two production bots.
- Runtime: llama.cpp b11179, Q4 quantisation, 2 generation threads and 4 prompt-processing threads.
- The prompt is the one Claude gets, scored from first-token logprobs at P(JOIN) ≥ 0.5.

| Judge (licence) | Right | Unwanted joins (of 22) | Missed (of 12) | ROC AUC | p50 time |
|---|---|---|---|---|---|
| Claude Sonnet 5 (same subset) | **97%** | 0 | 1 | — | 3.2 s |
| Claude Haiku 4.5 (same subset) | 85% | 0 | 5 | — | 3.4 s |
| **Qwen3-4B-Instruct-2507, compact prompt** (Apache-2.0) | **88%** | **0** | 4 | 0.81 | 7.6 s |
| **Gemma 4 E2B, compact prompt** (Apache-2.0) | **82%** | 1 | 5 | — | ~6 s |
| Gemma 4 E2B (Apache-2.0) | 79% | 3 | 4 | 0.82 | 4.7 s |
| Granite 4.0 micro (Apache-2.0) | 65% | 10 | 2 | 0.70 | 8.8 s |
| Qwen3-4B-Instruct-2507 (Apache-2.0) | 59% | 13 | 1 | 0.71 | ~11 s |
| Qwen3-1.7B (Apache-2.0) | 47% | 18 | 0 | 0.67 | 2.6 s |
| LFM2.5-1.2B (LFM licence: free under $10M revenue) | 47% | 14 | 4 | 0.51 | ~4 s |

**The prompt mattered more than the model size.** The rows marked *compact prompt* use `triageCompactPrompt`. It is a short prompt that states silence as the norm and shows ten worked examples, none of them taken from the test set.

- It turned Qwen3-4B-2507 from 59% right with 13 unwanted joins into 88% right with none, and Gemma 4 E2B from 79% into 82%.
- It did not help Qwen3-1.7B, which went to 35% and joined on everything.
- It hurts Claude: Haiku with it was 78% right and missed 19 of 32 openings.

So the bridge gives the local judge the compact prompt and Claude the full one.

**Check on all 90 cases**, with the compact prompt and P(JOIN) ≥ 0.5 (thresholds from 0.5 to 0.9 change little):

| Judge | Right | JOIN precision | JOIN recall | Unwanted joins (of 58) | Missed (of 32) | ROC AUC | p50 time |
|---|---|---|---|---|---|---|---|
| Claude Sonnet 5 (full prompt) | 96% | 94% | 94% | 2 | 2 | — | 3.2 s |
| Claude Haiku 4.5 (full prompt) | 88% | 89% | 75% | 3 | 8 | — | 3.4 s |
| Qwen3-4B-Instruct-2507, compact | 80% | 77% | 63% | 6 | 12 | 0.78 | 6.1 s |
| Gemma 4 E2B, compact | 73% | 75% | 38% | 4 | 20 | 0.75 | 3.0 s |
| Gemma 4 E2B, compact, P ≥ 0.7 | 78% | 100% | 38% | 0 | 20 | 0.75 | 3.0 s |

On the full set Qwen3-4B got Persian 12/12, but factual errors 0/5 and task requests 4/7, and it made unwanted joins on questions meant for a particular person (2) and on an in-progress message.

**Measured raw speed on this box** (llama-bench):

| Model | Prompt processing | Generation |
|---|---|---|
| Qwen3.5-0.8B | 60–80 tok/s | 10–22 tok/s |
| LFM2.5-1.2B | 53–75 tok/s | 11–22 tok/s |
| Qwen3.5-2B | 36 tok/s | 4 tok/s |
| LFM2.5-2.6B | 25 tok/s | 3 tok/s |

2 threads were as fast as 4 because the box is shared. Hybrid models (Qwen3.5, LFM2) can't reuse the cached system prompt in llama.cpp (issue #20225), so they reprocess the whole prompt on every call. A local judge also keeps the CPU busy for the whole look, on the same cores as the bots.

### Why the small models fail, and what would fix it

- **Zero-shot small models are biased toward speaking.** The research finds the same: "Speak or Stay Silent" (2026) measured 43–64% balanced accuracy across 8 LLMs. When2Speak measured false-interruption rates of 0.26–0.59.
- **Tuning fixes most of it.** GroupGPT (2026) tuned Qwen3-4B on 2,000 labelled chat segments and got 83% accuracy, against 58% for a prompted GPT-4o.
- **So the path to a local judge is to collect data first.** Run Auto with Claude judging, keep the `[auto]` log and the team's reactions, and fine-tune a 1–4B model on that.

## Recommendation

1. **Start with the Haiku judge** (the default). Unwanted joins were rare in the tests, and at about $0.0013 a look it barely registers next to the turns themselves. **Switch a topic to Sonnet** where the bot should chime in reliably: it missed 2 of 32 real openings where Haiku missed 8. The difference is about $0.004 a look.
2. **Keep eagerness at `balanced`**, and use `reserved` for busy topics. Neither the pause nor the ceiling costs anything.
3. **For no per-message cost at all, run the local judge**, at `reserved` eagerness to make up for its extra unwanted joins:

   ```
   llama-server -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf --port 8090 -c 4096 -t 2 -tb 4 --reasoning off
   TG_AUTO_JUDGE=local  TG_AUTO_LOCAL_URL=http://127.0.0.1:8090
   ```

   On this box that is about 6 s a look and a busy CPU while it runs, next to the bots. `nice` it. It is worth doing where Claude usage matters more than the difference between 80% and 88%, or while collecting data to tune a small model (below).
   - Qwen3-4B needs about 2.5 GB of RAM; Gemma 4 E2B needs about 3 GB.
   - Pure-transformer models (Qwen3, Gemma with `--swa-full`) reuse the cached system prompt. The hybrid models (Qwen3.5, LFM2) can't, on this llama.cpp.
4. **Try it in a small topic first**, then read the `[auto]` log lines for a day.

## ⚠️ One thing to check: Anthropic's terms for subscription use

Anthropic's Consumer Terms cover Free, Pro and Max (effective 2025-10-08; checked 2026-09-25 at anthropic.com/legal/consumer-terms). They say:

- no access "through automated or non-human means, whether through a bot, script, or otherwise", except with an API key or where Anthropic explicitly permits it;
- no making your account "available to anyone else";
- the version served to this server (EU) also says no "commercial or business purposes".

Claude Code's legal page adds that Pro and Max limits "assume ordinary, individual usage".

This is about xesious as a whole in a company group, not just the judge: the bot's own turns run on the owner's login. Two options are clearly within the terms:

- run the CLI with an **API key**, under the Commercial Terms: `ANTHROPIC_API_KEY`, billed per token (Haiku 4.5 at $1/$5 per million tokens puts a look at about $0.001);
- use a **Team or Enterprise** plan.

This is not legal advice; it is what the pages say.

## Open questions

- **Marking unprompted posts.** They are unmarked now. A marker ("✨") would tell people the bot was not asked, at the cost of a little noise.
- **Tier 3 is done and passed**, with real Telegram, the real Haiku judge and the real model (`feature_auto_mode`, 2026-09-25). A topic was set to Auto through `/config`.
  - "haha that meme was great 😂 anyone up for lunch at 1?" → `QUIET (haiku, 4514ms)`, and nothing was posted.
  - "Does anyone remember the default port PostgreSQL listens on?" → `JOIN (haiku, 3148ms)`, and the bot answered on its own: "PostgreSQL listens on 5432/tcp by default…".
- **Capping the bot's share of messages**, rather than only pausing after each join. The research suggests keeping it at about 1/n of the messages in the topic.
- **Strangers' messages in a look.** Only a message from an allowed person arms a look, but the look then judges everything new since the last one. That can include what someone not on the allowlist said just before. The joining turn treats all of it as background, never as instructions, under the existing attribution rules. The stricter option is to judge only allowed people's new messages; it is a one-line change if wanted.

## Reproduce

```
bun research/auto/bench.ts --backend claude:haiku --conc 4
bun research/auto/bench.ts --backend claude:sonnet --conc 4
llama-server -m gemma-4-E2B-it-Q4_0.gguf --port 8090 -c 4096 -t 2 -tb 4 --swa-full --reasoning off &
bun research/auto/bench.ts --backend local:http://127.0.0.1:8090 --name gemma --only "$(head -1 research/auto/subset.txt)" [--prompt compact]
```
