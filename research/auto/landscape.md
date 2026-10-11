# Auto mode: when should the bot speak? Landscape

Web research, 2026-09-25. "Unverified" marks things I could not confirm from a primary source.

## 1. Products and open-source bots

| Product | How it decides | Known problems |
|---|---|---|
| **OpenClaw** (ex-Clawdbot/Moltbot, renamed Jan 2026) | Mention-gated by default. `/activation always` runs the **main model on every message**. With `silentReply.group: "allow"`, the group prompt says reply only when you add value, else output exactly `NO_REPLY`. `visibleReplies: "message_tool"` inverts this: speaking requires a send-tool call. Telegram text is debounced 300 ms. | "Noisy fast" in busy groups. Silent turns are full paid calls, missing from cost metrics (#152185). The token fails both ways: appended to real text and posted (#30916), and direct questions in Telegram topics swallowed (#156257, P1). |
| **ChatGPT group chats** (Nov 2025) | The main model "decides when to respond and when to stay quiet". Writing "ChatGPT" forces a reply. Limits are charged only when it replies. | No new group chats since 9 Jul 2026 (reason unverified). A CHI'26 study: joining helped when talk lacked a next step, and disrupted active opinion exchange. |
| **Claude Tag** (Slack, Jun 2026) | @mention, standing triggers, and an "ambient" mode. | Guardrails are budgets: org and channel token caps, alerts at 75 %/95 %, and over-cap work is declined. |
| **Shapes** (Discord) | Per-chat "Free Will" triggers: mentioned, keep the conversation going, keywords, speak when nobody else does, return after a quiet spell. | No published reply-probability numbers (unverified). |
| **SillyTavern** | Name mention first; else each character rolls its Talkativeness (default 50 %); else a random pick. | The dice ignore content. |
| **Character.AI / Nomi** | Undisclosed selector. C.AI's auto-reply switch (Sep 2025) lets characters answer each other. | "They keep talking and won't let me in" (secondary source). |
| **ElizaOS** | A separate `shouldRespond` prompt returns RESPOND/IGNORE/STOP. Its rules include "when unsure, default IGNORE" and "a message X could answer is not a message X should answer; silence is a valid contribution". It ignores acks. | — |
| **Hermes Agent, llmcord** | Mention/reply only. Hermes logs unmentioned messages as context. | Users asked for a "stay silent" layer (#6643). |
| **Slack / Teams / Google Chat** | Adapt (Slack) offers mention-only, "smart" (a fast judge model checks each message against a plain-English policy) or always. Teams Facilitator posts on rules (timers, recaps), else only on @mention. Google Chat apps only receive @mentions unless subscribed through the Workspace Events API. | Keep policies narrow. |

Telegram: in privacy mode (the default), bots see only commands, replies and mentions. Turn it off in BotFather or make the bot an admin. Bots never see other bots' messages, and may post at most 20 messages/min per group.

## 2. Research 2023–2026

- **Inner Thoughts** (CHI 2025): the agent generates covert candidate thoughts on each new message or after a 10 s pause. It scores them on 8 heuristics (relevance, information gap, impact, urgency and others) and speaks only above a motivation threshold. Built on GPT-4o; raters preferred it over a turn-taking baseline 82 % of the time.
- **MUCA** (2024): decides what to say, when, and to whom, running every 3 messages in small groups. Chime-in probability rises with consecutive silent turns. 9 of 16 users found the GPT-4 baseline too chatty; nobody said that of MUCA.
- **GroupGPT** (Mar 2026): a tuned Qwen3-4B judge (2,000 labelled segments) scored 83.4 % accuracy and 88.7 F1 on chime-in timing. GPT-4o prompting scored 58.0/59.2 and humans 86.4/89.1. It used about 3× fewer tokens, and "stay silent" decisions came back in about 1 s.
- **When2Speak** (May 2026, 216k examples, CC BY-SA): zero-shot LLMs over-intervene, with false-interruption rates of 0.26–0.59. LoRA lifts Qwen3-4B's macro-F1 from 0.21 to 0.74, but the tuned models then miss about half of the warranted interventions.
- **Speak or Stay Silent** (Mar 2026): 8 LLMs show a strong bias toward speaking, with balanced accuracy of 43–64 %. Supervised fine-tuning adds up to 23 points; the authors say the skill "must be explicitly trained".
- **Time to Talk** (2025): a scheduler prompt chooses `<send>` or `<wait>`. When the agent's share of messages goes above 1/n, it switches to a "listener" prompt. It matched human message rates (4.28 vs 4.54).
- **ProactiveBench** (ICLR 2025): a reward model reached 91.8 % F1 against human labels; the best agent reached 66.5 % F1.
- **Addressee recognition**: GPT-4o is only marginally above chance (IWSDS 2025).

## 3. Cheap "speak now?" classifiers

- **Rules (free):** mentions and replies take the normal path. Drop stickers, emoji, "ok/thanks", replies to humans, and bursts where the bot spoke last.
- **Debounce:** judge a burst, not each message (OpenClaw's "collect" queue; Inner Thoughts on a 10 s pause; MUCA every N messages).
- **Small LLM, yes/no by logprob:** `llama-server` returns token probabilities (`n_probs`, OpenAI-style `logprobs`; Ollama ≥ 0.12.11 does too), and a GBNF grammar can force the output to `yes|no`. Scores aren't calibrated, so sweep the threshold on labelled data. Keep prompts append-only with the question last, so the prompt cache only processes new tokens. Turn thinking off.
- **Fine-tuned encoder:** ModernBERT is English-only. For Persian, use mmBERT (MIT, 1,800+ languages), mDeBERTa-v3 (MIT) or TookaBERT (Apache-2.0). Expect tens of ms on CPU (estimate); it needs hundreds of labels.
- **NLI zero-shot** (`MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7`, MIT, Persian in training): fine for "is this about X?". In my judgement it is weak at telling whether the bot is being addressed.
- **Embeddings + logistic regression / SetFit:** a good pre-filter with multilingual-e5-small (MIT), BGE-M3 (MIT) or Qwen3-Embedding-0.6B (Apache-2.0). Avoid jina-v3 (CC BY-NC).
- **Cascade:** rules → debounce → gate → main model, which can still decline. FrugalGPT matched GPT-4 at up to 98 % lower cost. Strip the silent token from mixed text, never let a direct address end silent, and count silent turns in the cost.
- **Cooldowns and budgets:** keep the bot to at most a 1/n share of messages, set a minimum gap between unprompted posts and a daily cap per topic, and give users a "stop" command.

## 4. Small open-weight models on this CPU

| Model | License | Persian | GGUF |
|---|---|---|---|
| Qwen3 0.6/1.7/4B; 4B-Instruct-2507 | Apache-2.0 | Listed; MELAC 49.3 (4B, best ≤4B) | `Qwen/Qwen3-1.7B-GGUF`, `unsloth/Qwen3-4B-Instruct-2507-GGUF` |
| Qwen3.5 0.8/2/4B (Mar 2026) | Apache-2.0 | 201 languages | `unsloth/Qwen3.5-2B-GGUF` |
| Gemma 3 270M/1B/4B, 3n | Gemma Terms (commercial OK; restrictions carry over; Google can restrict use) | 140+; MELAC 45.4 (4B) | `google/gemma-3-4b-it-qat-q4_0-gguf` |
| Gemma 4 E2B/E4B (Apr 2026) | Apache-2.0 | 140+ pretrained | `ggml-org/gemma-4-E2B-it-GGUF` |
| Llama 3.2 1B/3B | Llama 3.2 Community (700M MAU cap, "Built with Llama") | Not official | `bartowski/Llama-3.2-3B-Instruct-GGUF` |
| Phi-4-mini 3.8B | MIT | Not listed | `unsloth/Phi-4-mini-instruct-GGUF` |
| SmolLM3-3B | Apache-2.0 | No | `ggml-org/SmolLM3-3B-GGUF` |
| Granite 4.0 micro/h/nano; 4.1 | Apache-2.0 | No | `ibm-granite/granite-4.0-micro-GGUF` |
| LFM2/LFM2.5 350M–2.6B | **LFM Open License: free commercial use only under US$10M revenue** | No | `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` |
| Ministral 3 3B (Dec 2025) | Apache-2.0 (the 2024 Ministral 3B was API-only) | Not listed | `mistralai/Ministral-3-3B-Instruct-2512-GGUF` |

**Avoid:**
- Tiny Aya (has Persian) is CC BY-NC.
- EXAONE 4.0 is NC.
- Hunyuan's license excludes the EU, and this server's IP geolocates to Lithuania.

**Persian:** small zero-shot models are mediocre. Qwen2.5-3B scores about 74 % on Persian sentiment and 64 % on NLI.

**CPU speed** (Q4, llama.cpp). Nobody publishes 4-core Zen 3 figures:
- Llama 3.2 1B on a Ryzen 7 5700X (8 Zen 3 cores): 256 tok/s prompt, 31 tok/s generation (LocalScore).
- My estimate for 4 cores: about 110 / 70 / 30 tok/s prompt for 1B / 1.7B / 4B, and 8–30 tok/s generation. A cold 1,000-token prompt would take about 15 s on 1.7B; cached, about 1–3 s. Check with `llama-bench -t 2`.
- Prefix caching is reliable only on full-attention models: Qwen3, Llama, Phi, SmolLM3, Granite micro, Ministral. Gemma needs `--swa-full`. Qwen3.5, LFM2 and Granite-H re-process the whole prompt (llama.cpp #20225).

**Runtime:** `llama-server` is the lightest: one binary with prompt cache, grammars and logprobs. Ollama wraps the same engine in a daemon. ONNX Runtime suits encoders.

## 5. The Claude CLI angle

- **Terms:** Pro and Max fall under the Consumer Terms (8 Oct 2025).
  - No access "through automated or non-human means, whether through a bot, script, or otherwise" unless via an API key or explicitly permitted.
  - No making your account available to others.
  - The EEA/Swiss version also says "Non-commercial use only" (rest-of-world version unchecked).
  - Claude Code's legal page says subscription limits "assume ordinary, individual usage". Developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users".
- **Changes:**
  - 9 Jan 2026: server-side block on third-party harnesses using subscription tokens.
  - Feb 2026: explicit OAuth ban for other tools and the Agent SDK.
  - 4 Apr 2026: Pro and Max stopped covering tools like OpenClaw.
  - `--bare`, "recommended for scripted calls" and the future `-p` default, ignores OAuth and needs `ANTHROPIC_API_KEY`.
- **Limits:** a 5-hour session limit plus a weekly all-model cap (since Aug 2025), shared with claude.ai. Max gives 5×/20× Pro per session. Anthropic's 2025 estimate: Pro gets about 40–80 Sonnet hours a week. Claude Code's 5-hour limits doubled on 6 May 2026.
- **Verdict:** running a group gate per burst is not "individual usage". It eats the limits the bridge's replies need, and each `claude -p` loads Claude Code's full context. It is not sensible for Auto mode, and the bridge itself raises the same terms questions.
- **API prices (per million tokens):**
  - Haiku 4.5: $1 in / $5 out. Prompts under 4,096 tokens don't cache.
  - Sonnet 5: $2 / $10, cached from 1,024 tokens.
  - Sonnet 4.6: $3 / $15.

## Recommendation

Make silence the default and build a cascade.
1. Free rules, a 30–60 s per-topic debounce, a cooldown, a 1/n share and a daily cap.
2. A local gate: Qwen3-1.7B or Qwen3-4B-Instruct-2507 in `llama-server` with 2 threads under `nice`, append-only prompts and a calibrated P(yes). Don't use Qwen3.5 on CPU until its cache bug is fixed. If Persian accuracy is weak, use Haiku 4.5 with an API key (about $1.5 per 1,000 decisions), not the subscription.
3. The main session may still decline with a silent token that is stripped defensively.
4. Log decisions and reactions, then fine-tune the gate. Tuned 4B judges beat prompted frontier models here.

## Sources

- OpenClaw: https://docs.openclaw.ai/channels/groups · https://docs.openclaw.ai/channels/group-messages · https://docs.openclaw.ai/concepts/messages · https://github.com/openclaw/openclaw/issues/152185 · https://github.com/openclaw/openclaw/issues/30916 · https://github.com/openclaw/openclaw/issues/156257 · https://www.clawcloud.sh/guides/openclaw-group-chat-settings · https://en.wikipedia.org/wiki/OpenClaw
- https://openai.com/index/group-chats-in-chatgpt/ · https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt · https://dl.acm.org/doi/10.1145/3772363.3798392
- https://www.anthropic.com/news/introducing-claude-tag · https://support.claude.com/en/articles/15594475-what-is-claude-tag
- https://docs.shapes.inc/shapeschatsguide · https://docs.sillytavern.app/usage/core-concepts/groupchats/ · https://arcanumrpgs.com/blog/character-ai-group-chat/ · https://wiki.nomi.ai/How_does_automatic_group_chat_work%3F
- https://github.com/elizaOS/eliza/blob/main/packages/prompts/src/index.ts · https://github.com/NousResearch/hermes-agent/issues/6643 · https://github.com/jakobdylanc/llmcord
- https://adapt.com/changelog/proactive-agent-slack · https://support.microsoft.com/en-us/office/facilitator-in-microsoft-teams-meetings-37657f91-39b5-40eb-9421-45141e3ce9f6 · https://developers.google.com/workspace/events/guides/events-chat · https://core.telegram.org/bots/faq
- arXiv: 2501.00383 (Inner Thoughts) · 2401.04883 (MUCA) · 2603.01059 (GroupGPT) · 2605.05626 (When2Speak) · 2603.11409 · 2506.05309 · 2410.12361 · 2501.16643 · 2305.05176 (FrugalGPT) · 2407.01122 · 2209.11055 (SetFit) · 2508.00673 (MELAC) · 2509.06888 (mmBERT)
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md · https://github.com/ggml-org/llama.cpp/issues/20225 · https://particula.tech/blog/prompt-reprocessing-swa-hybrid-models-kv-cache · https://www.localscore.ai/model/3 · https://www.liquid.ai/lfm-license
- Models: https://qwenlm.github.io/blog/qwen3/ · https://huggingface.co/Qwen/Qwen3.5-2B · https://ai.google.dev/gemma/terms · https://huggingface.co/google/gemma-4-E2B-it · https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct · https://huggingface.co/microsoft/Phi-4-mini-instruct · https://huggingface.co/HuggingFaceTB/SmolLM3-3B · https://huggingface.co/ibm-granite/granite-4.0-h-micro · https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512 · https://huggingface.co/CohereLabs/tiny-aya-global · https://huggingface.co/convaiinnovations/laya · https://aclanthology.org/2026.silkroadnlp-1.10.pdf
- Claude: https://code.claude.com/docs/en/legal-and-compliance · https://code.claude.com/docs/en/headless · https://www.anthropic.com/legal/consumer-terms · https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/ · https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost · https://support.claude.com/en/articles/8325606-what-is-the-pro-plan · https://www.anthropic.com/news/higher-limits-spacex · https://platform.claude.com/docs/en/about-claude/pricing · https://platform.claude.com/docs/en/build-with-claude/prompt-caching
