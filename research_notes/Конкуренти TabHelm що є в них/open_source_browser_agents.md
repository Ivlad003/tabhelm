# Open-source browser-agent extensions and browsers (as of 2026-10-12): what they have that TabHelm lacks

Scope note: TabHelm's existing feature set (side-panel chat bound to a tab, 10 ACP terminal agents + built-in OpenRouter/Ollama agent, model picker, 25 tools with a11y-style snapshot incl. iframes, permissions/auto-approve, confirmations, video recording with agent cursor, history/continue, hand-over/failover, md/json export, attachments, skills from links, working folder + AGENTS.md, task stats, update banner, tab-group sharing, cross-tab search) is treated as baseline and NOT listed as a gap unless a project does it notably better.

Method: GitHub READMEs/releases, docs sites, Chrome Web Store, GitHub REST API (stars + `pushed_at` fetched 2026-10-12). Caveat: the page-summarising fetch tool rendered some release-note years wrongly (e.g., "2024" for releases that reference Gemini 3 / GPT-6 / Claude Opus 4.8); where that happened I give month/day and mark the year as uncertain, and rely on the GitHub API `pushed_at` for last-activity.

## Project inventory: status, stars, last activity, distribution

### Takeaway
All "core" projects except LaVague are alive in 2026; Open Operator is archived (May 2026) and hangwin/mcp-chrome has been quiet since Jan 2026. The 2026 wave of new extension-based agents is dominated by "let a coding agent (Claude Code/Codex/OpenClaw/Pi/Hermes) drive my real logged-in browser" tools (Tencent/BrowserSkill 8.7k stars, hermes-browser-extension 1.7k, anomalyco/browser-control 442, peerd 418, tactus 377) rather than by self-contained LLM-loop extensions like Nanobrowser.

### Cited Findings
Stars / last push / license from GitHub API on 2026-10-12 — [GitHub API](https://api.github.com/repos/):
- nanobrowser/nanobrowser: 14,077 stars, pushed 2026-10-02, Apache-2.0. Chrome Web Store: 50,000 users, 3.6/5 (66 ratings), v0.2.0, last updated Oct 6 2026 — [Chrome Web Store](https://chromewebstore.google.com/detail/nanobrowser/imbddededgmcgfhfpcjmijokokekbkal); README says Chrome/Edge only, Firefox/Safari "explicitly unsupported" — [README](https://raw.githubusercontent.com/nanobrowser/nanobrowser/master/README.md).
- browseros-ai/BrowserOS: 13,881 stars, pushed 2026-10-12, AGPL-3.0; monorepo = Chromium fork (C++) + agent platform (TS/Rust/Go: MCP server, dashboard, CLI); releases on Oct 11 2026 (neo extension v0.2.35.0, BrowserClaw server v0.0.69) and BrowserOS v0.51.0 on Oct 5 2026 (Chromium 155) — [GitHub](https://github.com/browseros-ai/BrowserOS); [Releases](https://github.com/browseros-ai/BrowserOS/releases).
- hangwin/mcp-chrome: 12,487 stars, pushed 2026-01-06 (quiet 9 months → mark semi-dormant), MIT; v1.0.0 (Dec 29) added "visual editor" and "claude code/codex in sidepanel" — [GitHub](https://github.com/hangwin/mcp-chrome); [Releases](https://github.com/hangwin/mcp-chrome/releases).
- alibaba/page-agent: 29,404 stars, pushed 2026-10-05, MIT, v1.12.4 — [GitHub](https://github.com/alibaba/page-agent); [Releases](https://github.com/alibaba/page-agent/releases).
- browser-use/browser-use: 117,748 stars, pushed 2026-10-09, MIT; v0.13.11 (Oct 7) — [GitHub](https://github.com/browser-use/browser-use); [Releases](https://github.com/browser-use/browser-use/releases). browser-use/workflow-use: 4,223 stars, AGPL-3.0, pushed 2026-10-09 — [GitHub](https://github.com/browser-use/workflow-use).
- Skyvern-AI/skyvern: 23,185 stars, pushed 2026-10-12, AGPL-3.0 (anti-bot features proprietary in cloud) — [GitHub](https://github.com/Skyvern-AI/skyvern).
- browserbase/stagehand: 25,640 stars, pushed 2026-10-12, MIT; TS/Python/Go SDKs; docs have v2/v3/v4 tracks — [GitHub](https://github.com/browserbase/stagehand); [docs index](https://docs.stagehand.dev/llms.txt).
- steel-dev/steel-browser: 7,791 stars, pushed 2026-10-09, Apache-2.0, "public beta" — [GitHub](https://github.com/steel-dev/steel-browser).
- hyperbrowserai/hyperbrowser: repo returns 404 (not public); hyperbrowserai/HyperAgent 1,595 stars, pushed 2026-05-11 (dormant 5 months) — [GitHub API](https://api.github.com/repos/hyperbrowserai/HyperAgent); docs at [hyperbrowser.ai/docs](https://hyperbrowser.ai/docs/llms.txt).
- OpenHands/OpenHands: 90,739 stars, pushed 2026-10-12, v1.27.1 — [GitHub](https://github.com/OpenHands/OpenHands).
- EmergenceAI/Agent-E: 1,252 stars, pushed 2026-05-04 (dormant), MIT — [GitHub](https://github.com/EmergenceAI/Agent-E).
- lavague-ai/LaVague: 6,393 stars, pushed 2025-01-21 → DORMANT ~21 months — [GitHub API](https://api.github.com/repos/lavague-ai/LaVague).
- MODSetter/SurfSense: 16,390 stars, pushed 2026-10-12; now positioned as "air-gapped NotebookLM alternative" desktop app; README no longer describes a browser agent or Chrome extension — [GitHub](https://github.com/MODSetter/SurfSense). (Out of scope as a browser agent.)
- bytedance/UI-TARS-desktop: 39,250 stars, pushed 2026-10-09, Apache-2.0; latest v0.3.1 (Oct 8, security release: access tokens + host validation for remote deployments), v0.3.0 (Nov 4, 2025) — [Releases](https://github.com/bytedance/UI-TARS-desktop/releases); [search summary](https://aiagentindex.mit.edu/2025/ui-tars-desktop).
- browserbase/open-operator: ARCHIVED May 20 2026 (1,950 stars); development moved to browserbase/gtm-demos — [GitHub](https://github.com/browserbase/open-operator).
- Areo-Joe/chrome-acp: 191 stars, pushed 2026-04-09 (6 months quiet), MIT — [GitHub](https://github.com/Areo-Joe/chrome-acp).
- aganhui/acp-sidepanel: 0 stars, 6 commits, pushed 2026-09-11, MIT — [GitHub](https://github.com/aganhui/acp-sidepanel).
- FellouAI/eko (open-source framework behind Fellou): 4,961 stars, pushed 2026-03-03 (7 months quiet), MIT; v4.0 Nov 2025 — [GitHub](https://github.com/FellouAI/eko). Fellou browser itself is closed source; raised $40.4M+; tiers $20–$200/mo — [Cerebral Valley](https://cerebralvalley.beehiiv.com/p/fellou-is-reimagining-the-agentic-browser).
- New 2026 projects found via GitHub search (`browser agent extension created:>2026-01-01`, sorted by stars) — [GitHub search API](https://api.github.com/search/repositories?q=browser+agent+extension+created:%3E2026-01-01&sort=stars):
  - Tencent/BrowserSkill 8,722 stars, pushed 2026-10-12, MIT — [GitHub](https://github.com/Tencent/BrowserSkill)
  - zhu1090093659/deepseek-pp 1,863 (DeepSeek web extension with MCP, memory, skills, automation), pushed 2026-08-13
  - abundantbeing/hermes-browser-extension 1,661, pushed 2026-10-11, MIT — [GitHub](https://github.com/abundantbeing/hermes-browser-extension)
  - anomalyco/browser-control 442, pushed 2026-10-11, MIT — [GitHub](https://github.com/anomalyco/browser-control)
  - NotASithLord/peerd 418, pushed 2026-10-12, Apache-2.0 — [GitHub](https://github.com/NotASithLord/peerd)
  - Castor6/tactus 377, pushed 2026-05-10, Apache-2.0, on Chrome Web Store — [GitHub](https://github.com/Castor6/tactus)
  - fitchmultz/pi-agent-browser-native 235; ofershap/real-browser-mcp 55; AliSharjeell/OpenBUA 46 — [GitHub](https://github.com/AliSharjeell/OpenBUA); pixiebrix/agent-browser-shield 34 — [GitHub](https://github.com/pixiebrix/agent-browser-shield)
  - Small side-panel agents (≤10 stars): esterhuizen/opensidekick (9, on CWS), krisshkodrani/OpenSidebar (5, on CWS), uni-native/agentbrowser (0, fork of VasiHemanth/agentbrowser), timurabi3/ai-sidebar-browser-agent (0), NatBrian/chrome-llm-automation (0, Set-of-Marks) — [search](https://github.com/esterhuizen/opensidekick), [OpenSidebar](https://github.com/krisshkodrani/OpenSidebar), [agentbrowser](https://github.com/uni-native/agentbrowser).
- formulahendry/acp-ui (498 stars, cross-platform ACP client desktop/mobile/web, pushed 2026-05-25) is the most-starred generic ACP client — [GitHub API](https://api.github.com/repos/formulahendry/acp-ui).

### Inferences
- TabHelm's closest architectural relatives (ACP client inside a Chrome extension) are tiny and mostly stale: chrome-acp (191 stars, no commits since April 2026, only 3 browser tools: tab list, DOM read, JS exec) and acp-sidepanel (0 stars, chat-only, no browser-driving tools). The nearest *active* relatives instead use MCP/CDP relays (BrowserSkill, browser-control, agentbrowser) — TabHelm's "10 agents over ACP + 25 tools" is a differentiated position, but discoverability is low because the ecosystem's vocabulary is "MCP/skill for Claude Code".
- The star-rich projects in 2026 are either infrastructure (browser-use, Stagehand, Skyvern) or "real logged-in browser for coding agents" (BrowserOS neo, BrowserSkill). TabHelm sits between them.

### Gaps
- Could not retrieve Chrome Web Store user counts for BrowserOS extensions, tactus, OpenSidebar, OpenSidekick (not fetched).
- No Hacker News/Reddit 2026 threads surfaced for Nanobrowser; search returned only aggregator reviews — [stork.ai review](https://www.stork.ai/ru/nanobrowser).

## Page representation tricks TabHelm lacks

### Takeaway
The notable gaps vs TabHelm are: (1) Set-of-Marks / labelled screenshots (BrowserGym/OpenHands, browser-control `screenshotWithLabels`, browser-use `highlight_elements`, NatBrian SoM); (2) screenshot diffing between steps (browser-control `screenshotDiff`); (3) paint-order / occlusion filtering of the DOM tree (browser-use); (4) explicit vision modes `use_vision = "auto" | True | False` with `vision_detail_level` (browser-use), and DOM/visual/hybrid grounding switches (UI-TARS browser operator); (5) a "readable markdown" page mode (Readability+Turndown in tactus; Steel's markdown/readability outputs); (6) WebMCP – discovering tools registered by the page itself (Stagehand, browser-control); (7) an in-page content sanitizer (agent-browser-shield) that strips page chrome / hidden text / PII before the model sees it.

### Cited Findings
- browser-use `highlight_elements` (default True) "Highlights interactive elements for AI vision"; `paint_order_filtering` (default True) removes elements hidden behind others; `cross_origin_iframes` (default False); `use_vision` accepts `"auto"` (adds a screenshot tool, only uses vision when requested), True or False; `vision_detail_level` low/high/auto; `max_history_items` caps prior steps in LLM memory; `include_attributes` chooses which HTML attributes are serialized; `page_extraction_llm` lets a cheaper model do extraction — [browser-use agent params](https://docs.browser-use.com/customize/agent/all-parameters); [browser params](https://docs.browser-use.com/customize/browser/all-parameters).
- browser-use `flash_mode` "skips evaluation, next goal and thinking" for speed; `use_thinking` toggle — [browser-use agent params](https://docs.browser-use.com/customize/agent/all-parameters).
- OpenHands browsing agent observations "include set-of-marks annotated web-page screenshots, accessibility trees of the web-page, and all thoughts and actions from previous steps"; BrowserGym overlays element boxes + `bid` attributes on screenshots (`overlay_som`), marks elements with a `browsergym_set_of_marks` JS tag — [HF mirror of OpenHands visualbrowsing_agent README](https://huggingface.co/spaces/Backup-bdg/OpenHands/blob/main/openhands/agenthub/visualbrowsing_agent/README.md); [BrowserGym changelog](https://data.safetycli.com/changelogs/browsergym/?page=1&).
- anomalyco/browser-control exposes `snapshot()` (compact structural view with `[ref=e12]` refs that persist across same-document navigation), `ariaSnapshot()` (a11y tree with native control values), `screenshotWithLabels()` (annotated screenshots with element metadata), and `screenshotDiff()` (pixel-level change detection against baselines); also `webmcp.list()/call()` for page-registered tools — [browser-control README](https://github.com/anomalyco/browser-control).
- Stagehand: "hybrid accessibility-tree trimming", "deep locators for nested iframes and closed Shadow DOMs", WebMCP ("List and invoke tools registered by the current web page"), OpenTelemetry tracing — [Stagehand README](https://github.com/browserbase/stagehand); [docs index](https://docs.stagehand.dev/llms.txt).
- Skyvern uses screenshot + DOM "together: the image shows layout and visual context, the DOM provides precise element identifiers"; the visible page is scraped into a simplified tree of interactive elements with labels and positions — [Skyvern docs intro](https://www.skyvern.com/docs/getting-started/introduction).
- UI-TARS Desktop browser operator supports GUI-agent (visual), DOM, and Hybrid control strategies; screenshot-based grounding with local UI-TARS-1.5-7B — [UI-TARS-desktop README](https://github.com/bytedance/UI-TARS-desktop).
- Agent-E DOM distillation offers three content modes (`text_only`, `input_fields`, `all_fields`) and injects `mmid` identifiers, built on accessibility trees — [Agent-E README](https://github.com/EmergenceAI/Agent-E).
- page-agent is text-only DOM ("no screenshots", no multimodal model needed) and runs in-page via one `<script>`; its v1.12.0 added "Tab status now included in agent context" — [page-agent README](https://github.com/alibaba/page-agent); [Releases](https://github.com/alibaba/page-agent/releases).
- tactus extracts page via "Readability + Turndown ... convert to Markdown", with per-site option to send raw page content — [tactus README](https://github.com/Castor6/tactus).
- Steel converts pages to markdown, readability views, screenshots or PDFs — [steel-browser README](https://github.com/steel-dev/steel-browser).
- hangwin/mcp-chrome: `chrome_screenshot` "with element targeting", `chrome_get_interactive_elements`, v0.0.5 added base64 screenshot image compression; semantic/vector search across tabs with WASM SIMD — [mcp-chrome README](https://raw.githubusercontent.com/hangwin/mcp-chrome/master/README.md).
- BrowserSkill extension captures DOM snapshots with element refs, "full-page and viewport screenshots (with automatic scrolling capability)", console output, request/response bodies, performance metrics, form field values and page state changes — [BrowserSkill README](https://github.com/Tencent/BrowserSkill).
- agentbrowser (uni-native fork) offers `a11y_tree`, `dom_inspect`, `network_log` (HAR), `dialog_list`, and page *annotation* tools (`annotate`, `annotate_batch`, `annotate_reply`) that let the agent underline/highlight/circle passages with comment threads for the user, plus live reversible CSS/HTML `patch_apply`/`patch_revert` — [agentbrowser README](https://github.com/uni-native/agentbrowser).
- agent-browser-shield (MV3) rewrites pages before the model sees them: removes footers/cookie banners/chat widgets/sponsored content, masks PII and credentials, suppresses hidden text and HTML comments carrying injection payloads; rules like `ads-hide`, `pii-redact`, `scarcity-redact`; PolyForm Shield license — [agent-browser-shield README](https://github.com/pixiebrix/agent-browser-shield).
- NatBrian/chrome-llm-automation: SoM overlays injected by content script, actions grounded by `markId`; Observe→Think→Act→Verify loop; AUTO vs REVIEW modes — [README](https://github.com/NatBrian/chrome-llm-automation).
- BrowserOS neo claims "Reduces token consumption through compact page snapshots" — [browseros.com/agents](https://www.browseros.com/agents).

### Inferences
- TabHelm's ref-based a11y snapshot is on par with browser-control/Stagehand/BrowserSkill; the missing layer is the *visual* one (labelled screenshots, screenshot diff) and the *token-budget* knobs (vision auto mode, history cap, attribute whitelist, paint-order filter).
- A "page sanitizer / injection filter" step (as agent-browser-shield does) is a security feature none of the ACP-relatives have; it would be cheap to add on top of the existing snapshot.

### Gaps
- No source found describing page-agent's user-facing highlight/mask overlay in detail (docs site 404; README summary only mentions a "status panel").
- Did not find documentation of DOM-diffing between steps in any mainstream project beyond browser-control's pixel `screenshotDiff`.

## Agent-loop features

### Takeaway
Gaps vs TabHelm: planner/navigator/validator role splits (Nanobrowser — though it *removed* its validator in v0.1.9; Skyvern V2 Planner/Task Agent/Validator; OpenSidebar planner/executor/verifier/judge), record-and-replay workflows with self-healing (workflow-use, Stagehand caching, browser-control `demonstrate()`, OpenSidekick), prompt templates/slash commands (OpenSidekick), scheduling (BrowserOS natural-language schedules in a hidden background window; OpenSidekick; Fellou), parallel agents each in their own colored tab group with a live "cockpit" dashboard and scrubbable video replay (BrowserOS neo), a dedicated "human help / take over" request (BrowserOS neo, BrowserSkill, browser-control `handoff()`), cost/judge/QA layers (browser-use `calculate_cost`, `fallback_llm`, `max_failures`, `final_response_after_failure`, QA skill 1–5 score), and "site clients learned once and reused" (peerd).

### Cited Findings
- Nanobrowser: Planner (recommends Claude Sonnet 5.5) + Navigator (Claude Haiku 4.5) with different models per agent; v0.1.9 "Removed validator agent, transferring responsibilities to planner"; v0.2.0 moved from LangChain to Vercel AI SDK, added "reasoning effort settings replacing temperature"; v0.1.13 added text file attachment to chat — [README](https://github.com/nanobrowser/nanobrowser); [Releases](https://github.com/nanobrowser/nanobrowser/releases) (fetch tool reported the year as 2024; models referenced (Gemini 3, GPT-6) and CWS update Oct 6 2026 imply 2026).
- Skyvern V2: Planner (breaks prompts into sub-tasks), Task Agent, Validator "confirms completion with feedback loops"; `page.validate()`, `page.agent.login()`, `page.agent.download_files()`; workflows with loops, conditionals, file parsing, email sending, custom code blocks; default max 50 steps per run; task queue states (created/queued/running/completed/failed/terminated/timed_out/canceled) — [Skyvern docs intro](https://www.skyvern.com/docs/getting-started/introduction); [Skyvern README](https://github.com/Skyvern-AI/skyvern); [Skyvern quickstart](https://www.skyvern.com/docs/introduction).
- browser-use: `max_actions_per_step` (5), `max_failures` (5), `final_response_after_failure`, `step_timeout` 180s, `llm_timeout`, `fallback_llm`, `calculate_cost`, `initial_actions` (deterministic pre-steps without LLM), `generate_gif`, `save_conversation_path`, `output_model_schema` (structured output), `directly_open_url` — [agent params](https://docs.browser-use.com/customize/agent/all-parameters). Browser Use ships 6 agent skills (browser-use CLI, cloud, open-source, `qa` "return a 1–5 quality score with evidence", remote-browser, x402) installable via `npx skills add` into `.claude/skills/` — [skills overview](https://docs.browser-use.com/open-source/examples/skills/overview). CLI 3.0 with background daemon keeping the browser open (~50ms per call) — [search summary](https://qwenlm.github.io/qwen-code-docs/en/users/features/browser-use/).
- workflow-use ("RPA 2.0", "Record Once, Reuse Forever"): recorder extension captures interactions → JSON workflow, variable extraction parameterizes inputs, self-healing invokes Browser Use when a step fails; maintainers call LLM fallback "really bad"; "very early development" — [workflow-use README](https://github.com/browser-use/workflow-use).
- Stagehand caches `act()`/`observe()`/`extract()` server-side; cache key = instruction + page content + options (model excluded); hits return "with no LLM inference and no token cost"; cached `act()` replays deterministically and "falls back to full inference" if selector no longer resolves; threshold of identical runs before serving — [Stagehand caching](https://docs.stagehand.dev/v4/best-practices/caching.md). Stagehand `agent()` integrates computer-use APIs from Google, Anthropic, OpenAI, Microsoft — [docs index](https://docs.stagehand.dev/llms.txt).
- browser-control: `demonstrate()` for recorded workflows; `handoff()` for human-only steps (CAPTCHA, 2FA, WebAuthn); read-only session mode — [README](https://github.com/anomalyco/browser-control).
- BrowserOS: Scheduled Tasks set in natural language ("Schedule this to run every morning") or settings; daily/hourly/every-N-minutes; "A hidden browser window opens automatically. The task runs there so it never interrupts whatever you are working on"; last 15 runs kept; 10-minute timeout; app must be open, missed runs execute on reopen — [Scheduled Tasks](https://docs.browseros.com/browseros/features/scheduled-tasks.md). Smart Nudges "suggests app connections and task scheduling at the right moment" — [docs index](https://docs.browseros.com/llms.txt).
- BrowserOS neo: "Every agent opens its own tabs ... never touches the ones you already have open"; each AI's tabs in its own colored tab group titled with the agent name; closing an agent tab is noticed immediately; closing a session removes its tab group; cockpit dashboard shows site, tool, step count for multiple parallel agents (Claude Code, Codex, Cursor); neo extension v0.2.35.0 "Added setting to disable human help feature"; BrowserClaw server v0.0.69 mentions "ACP agent session persistence" — [tabs-and-isolation](https://docs.browseros.com/neo/tabs-and-isolation.md); [browseros.com/agents](https://www.browseros.com/agents); [Releases](https://github.com/browseros-ai/BrowserOS/releases).
- BrowserOS neo audit/replay: one screenshot per step, every tool call with args/results, per-tab timelines; stored in `~/.browserclaw/` (sqlite + screenshots/ + replays/); replay shows actual DOM changes/scrolling/clicks with a scrubber and jump-to-action timeline; password fields masked, canvas and cursor movements excluded — [audit-and-replay](https://docs.browseros.com/neo/audit-and-replay.md).
- BrowserSkill: "An existing tab can be explicitly borrowed and returned when the task ends"; distinct Agent Window; optional tab-borrowing confirmation and "human-help requests"; closing the window stops tasks — [BrowserSkill README](https://github.com/Tencent/BrowserSkill).
- OpenSidekick: three autonomy modes (plan-first approval, ask-before-acting, automatic), saved prompt templates with slash-command insertion, scheduled tasks with notifications, workflow recording and "intelligent replay", on-page activity indicator with stop — [OpenSidekick README](https://github.com/esterhuizen/opensidekick).
- OpenSidebar: planner/executor/verifier/optional judge roles; checkpoints; page-change monitoring; local trace viewer for run replay; pauses before critical actions — [OpenSidebar README](https://github.com/krisshkodrani/OpenSidebar).
- peerd: "Site clients: learns websites once, reuses clients for future tasks"; scoped keyless actors per page; sandboxed JS notebooks, WASI tools and Linux WebVMs in-extension; local sessions/memory/skills; BYOK, no backend, no telemetry — [peerd README](https://github.com/NotASithLord/peerd).
- Fellou: Deep Action plan reviewed before execution; "Shadow Workspace" runs tasks in a separate background layer while the user browses; scheduling "at a specific time or on a recurring basis"; multi-modal reports (text, charts, slides, sheets) — [fellou.ai](https://fellou.ai/). Eko: workflow generation from NL, human-in-the-loop hooks, dependency-aware parallel execution (v3.0), chat conversations (v4.0) — [Eko README](https://github.com/FellouAI/eko).
- UI-TARS/Agent TARS: replay mode with shareable execution reports, Event Stream protocol, "thinking duration" visualization, runtime settings and timing statistics (v0.3.0) — [Releases](https://github.com/bytedance/UI-TARS-desktop/releases).
- OpenBUA: Global Memory vs Tab Memory self-learning, human-in-the-loop CAPTCHA with auto-resume, multi-tab parallel tasks — [OpenBUA README](https://github.com/AliSharjeell/OpenBUA).
- hangwin/mcp-chrome roadmap: Recording and Playback, Workflow Automation, Firefox — [README](https://raw.githubusercontent.com/hangwin/mcp-chrome/master/README.md).

### Inferences
- TabHelm's video recording is comparable to BrowserOS neo's replay in spirit, but neo adds a searchable audit DB (filter by agent/status/site), per-step screenshots and a jump-to-action timeline; that is a notably better implementation of the same idea.
- Scheduling in a hidden window (BrowserOS) is the most concrete reference design for "background tabs in separate windows" that TabHelm lacks.
- Deterministic replay (workflow-use / Stagehand cache / browser-control demonstrate) is the clearest cost lever none of the ACP-relatives offer.

### Gaps
- No documented cost caps (dollar budgets) in any project; only step/failure/timeouts (browser-use, Skyvern 50 steps, BrowserOS 10-minute scheduled-task timeout).
- Could not verify the UX of BrowserOS neo "human help" beyond the release-note line and BrowserSkill's "human-help requests".

## Robustness: dialogs, captcha, logins, downloads, PDFs, iframes/shadow DOM, waiting, retries

### Takeaway
Infrastructure projects (Skyvern, Browserbase/Stagehand, Hyperbrowser, Steel) solve captcha/2FA/proxies as paid cloud features; extension-based projects explicitly hand captcha/2FA to the human (browser-control `handoff()`, OpenBUA, BrowserSkill human-help) and lean on the real logged-in profile to avoid logins. Concrete gaps for TabHelm: dialog interception tools (`dialog_list`/`dialog_respond` in agentbrowser), auto PDF download + markdown rendering (browser-use `auto_download_pdfs`, v0.13.9 "markdown PDF rendering"), default ad-block/cookie-banner extensions (browser-use loads uBlock Origin, cookie handlers, ClearURLs), wait tuning (`minimum_wait_page_load_time`, `wait_between_actions`), fallback LLM, and TOTP/credential injection (Skyvern).

### Cited Findings
- browser-use: `accept_downloads` (True), `downloads_path`, `auto_download_pdfs` (True), `enable_default_extensions` (True: uBlock Origin, cookie handlers, ClearURLs), `minimum_wait_page_load_time` 0.25s, `wait_between_actions` 0.1s, `deterministic_rendering`, `cross_origin_iframes`, `keep_alive` — [browser params](https://docs.browser-use.com/customize/browser/all-parameters); v0.13.9 "cookie clearing via Storage domain, markdown PDF rendering"; v0.13.7 "Cross-origin iframe extraction fixes"; v0.13.4 "LLM truncation detection" — [Releases](https://github.com/browser-use/browser-use/releases).
- Skyvern: 2FA via TOTP secrets stored with credentials ("Skyvern generates codes locally"), pushed codes, pull endpoints, magic links; `send-totp-code` API; TOTP webhook includes `workflow_permanent_id`; AI can "solve simple image-based CAPTCHA challenges", residential proxies in 30+ countries; password managers (Bitwarden, 1Password, LastPass); downloads uploaded to block storage with checksums; browser session persistence 6h; livestream of viewport — [handle-2fa](https://skyvern.com/docs/developers/credentials/handle-2fa); [intro](https://www.skyvern.com/docs/getting-started/introduction); [README](https://github.com/Skyvern-AI/skyvern).
- Stagehand/Browserbase: "verified identity modes, residential proxies, captcha solving, live session replay, and takeover"; self-healing `act()`; deep locators for nested iframes and closed shadow DOM — [Stagehand README](https://github.com/browserbase/stagehand).
- Hyperbrowser: automatic CAPTCHA solving + manual evaluation endpoints (Turnstile, Cloudflare, reCAPTCHA), proxies/geo, profiles, live view "watch and interact", recordings/video replays, custom Chrome extensions in sessions — [docs index](https://hyperbrowser.ai/docs/llms.txt).
- Steel: session state persistence, proxy chains, stealth/fingerprint management, custom extensions, request logging UI — [README](https://github.com/steel-dev/steel-browser).
- browser-control: relay "blocks destructive CDP commands (cookie/cache clearing, browser closure)"; `handoff()` for CAPTCHA/2FA/WebAuthn; `fillInput()` for cases where extensions interfere; refs persist across same-document navigation — [README](https://github.com/anomalyco/browser-control).
- agentbrowser: `dialog_list` / `dialog_respond` tools; fallback to system notifications when page injection isn't possible — [README](https://github.com/uni-native/agentbrowser).
- Nanobrowser v0.1.13: "Fixed infinite loop affecting live nodes and sandboxed iframes", "Upgraded clickable element detection to iterative implementation"; v0.1.9: "Improved CORS error handling for inaccessible frames" — [Releases](https://github.com/nanobrowser/nanobrowser/releases).
- BrowserOS pitch: "no headless scraping, no fake user agents, no captchas that stop it dead" (relies on real profile) — [search summary](https://www.browseros.com/agents).
- OpenBUA: form automation via synthetic events "compatible with React/Vue/Angular"; human-in-the-loop CAPTCHA with automatic resumption — [README](https://github.com/AliSharjeell/OpenBUA).
- LaVague driver table listed "iframe handling" for Selenium/Playwright and "element highlighting" for its Chrome Extension — [README](https://github.com/lavague-ai/LaVague) (dormant).

### Inferences
- The extension-world consensus stance on captcha is "ask the human" rather than solve; TabHelm's confirmation system could add an explicit `request_human_help` tool to match browser-control/BrowserSkill.
- Automatic PDF-to-text and a built-in content blocker are low-cost robustness wins seen in browser-use.

### Gaps
- No primary-source details found on shadow-DOM handling in Nanobrowser, page-agent, BrowserOS or BrowserSkill.
- No documentation found on retry/backoff policy for Nanobrowser or BrowserOS.

## Integrations: MCP, app connectors, webhooks, REST/CLI triggers, SDKs, cloud

### Takeaway
Biggest integration gaps: (1) exposing the browser as an MCP server / CLI so external agents (Claude Code, Codex, Cursor, OpenClaw, Pi, Hermes) can drive it (BrowserOS one-click MCP install board, mcp-chrome, page-agent MCP beta, BrowserSkill, browser-control, Skyvern/Stagehand hosted MCP); (2) 40+ OAuth app connectors (BrowserOS Connect Apps; Fellou: Google/Notion/Reddit/X); (3) MCP *client* support inside the extension for extra tools (tactus, OpenSidekick, deepseek-pp); (4) REST API + webhooks + Zapier/Make/n8n for triggering (Skyvern, Browser Use Cloud, BrowserOS n8n); (5) agent-skill packages distributed via `npx skills add` (browser-use) and Agent Skills spec import with script trust (tactus).

### Cited Findings
- BrowserOS neo: one-click MCP connect for Claude Code, Cursor, Codex, VS Code, Zed, OpenCode, Hermes, OpenClaw, Antigravity; Claude Desktop/Cowork via a one-file extension; "add the BrowserOS neo skill so your agent uses it well" — [docs index](https://docs.browseros.com/llms.txt); [README](https://github.com/browseros-ai/BrowserOS).
- BrowserOS Connect Apps: 40+ apps (Gmail, Outlook, Google Calendar, Slack, Discord, WhatsApp, Teams, GitHub, GitLab, Linear, Jira, Asana, Notion, Google Docs/Sheets/Drive, Confluence, Airtable, Dropbox, Figma, Salesforce, HubSpot, Shopify, Stripe…) via OAuth, surfaced as interactive one-click-authorize cards when a task needs an unconnected app; also n8n integration page — [connect-mcps](https://docs.browseros.com/browseros/features/connect-mcps.md); [docs index](https://docs.browseros.com/llms.txt).
- BrowserOS Cowork: 7 filesystem tools (read/write/edit files, shell commands, regex search, find by pattern, list dirs) sandboxed to one chosen folder; "Select No folder to instantly disable file access"; Agent Mode only — [cowork](https://docs.browseros.com/browseros/features/cowork.md). (TabHelm's working-folder is similar; Cowork adds shell commands.)
- hangwin/mcp-chrome: fastify bridge at `http://127.0.0.1:12306/mcp`, streamable HTTP + stdio; tools incl. `chrome_history`, bookmark add/search/delete, `chrome_network_debugger_start/stop` with response bodies, `chrome_network_request`, `chrome_inject_script`, `search_tabs_content` semantic search — [README](https://raw.githubusercontent.com/hangwin/mcp-chrome/master/README.md).
- page-agent: MCP Server (Beta) for external control; NPM package; CDN one-liner — [README](https://github.com/alibaba/page-agent).
- Skyvern: Zapier, Make.com, N8N integrations; Python/TypeScript SDK; MCP; connect local Chrome via remote debugging or tunnel to cloud; livestream; webhooks for TOTP — [README](https://github.com/Skyvern-AI/skyvern); [search summary](https://www.skyvern.com/docs/sdk-reference/credentials/send-totp-code.md).
- Stagehand: hosted MCP server for Claude, Cursor, Codex; TS/Python/Go SDKs; Browserbase Model Gateway; `metrics()` per-method token usage — [README](https://github.com/browserbase/stagehand); [docs index](https://docs.stagehand.dev/llms.txt).
- Browser Use: cloud REST API (v2/v3), Python/TS SDKs, CLI, Anthropic toolsets "all 31 browser actions" (v0.13.11), MCP registry support (v0.13.5), OpenClaw skill support (v0.13.8), cloud browsers $0.02/browser-hour, profile sync (cookies only) — [README](https://github.com/browser-use/browser-use); [Releases](https://github.com/browser-use/browser-use/releases).
- Steel: REST API with OpenAPI/Swagger, Node/Python SDKs, Puppeteer/Playwright/Selenium, Docker/Railway/Render deploy — [README](https://github.com/steel-dev/steel-browser).
- Hyperbrowser: runs Browser-Use, Claude Computer Use, OpenAI CUA, HyperAgent (`page.ai()/perform()/extract()`); MCP integration; Node/Python SDKs; sandboxes CLI — [docs index](https://hyperbrowser.ai/docs/llms.txt).
- BrowserSkill: Rust CLI/daemon + extension + "Agent Skill" layer; integrations for Cursor, Claude Code, Codex, OpenClaw, CodeBuddy, WorkBuddy, Pi, Hermes; DeepSeek Harness plugin with native `browser_*` tools — [README](https://github.com/Tencent/BrowserSkill).
- browser-control: OpenCode native plugin, Claude Code via MCP, shell agents via skill, Effect TypeScript client; relay at 127.0.0.1:19989 — [README](https://github.com/anomalyco/browser-control).
- agentbrowser: adapters for claude-agent-sdk, CLI agents (claude, codex, opencode, copilot, grok, gemini, devin…), ACP adapters (acp-gemini, acp-codex, acp-opencode, acp-copilot, acp-grok, acp-claude…), and an `mcp-proxy.mjs` so any MCP harness can drive the browser — [README](https://github.com/uni-native/agentbrowser).
- tactus: imports spec-compliant Agent Skills folders (`SKILL.md` + scripts/references/assets); first script run requires confirmation with "permanently trust" option; tools from connected MCP servers — [README](https://github.com/Castor6/tactus).
- OpenSidekick: MCP server integration; OpenSidebar: none — [OpenSidekick](https://github.com/esterhuizen/opensidekick).
- Hermes browser extension: three connection modes (local gateway, Hermes Cloud via dashboard attach, remote gateway); "Bot Mode" agent roster and group chats; Firefox supported via AMO but without tab automation — [README](https://github.com/abundantbeing/hermes-browser-extension).
- chrome-acp: proxy server (WebSocket) between extension and ACP agent on stdin/stdout; remote access with HTTPS + QR auth; runs on Android via Termux; PWA web client alternative; agents: Claude Code, Codex CLI, OpenCode, Gemini CLI, Qwen Code, Augment — [README](https://github.com/Areo-Joe/chrome-acp).
- acp-sidepanel: stdio-to-WebSocket bridge on localhost:3000 → Claude Code CLI; session create/switch/resume/delete; auto-reconnect with 30s grace; optional per-session permission bypass — [README](https://github.com/aganhui/acp-sidepanel).
- UI-TARS/Agent TARS: kernel built on MCP (mount servers for flights, hotels, data viz); MCP official registry support; Agent UI Builder CLI — [README](https://github.com/bytedance/UI-TARS-desktop); [Releases](https://github.com/bytedance/UI-TARS-desktop/releases).

### Inferences
- The dominant 2026 integration pattern is *inverting* TabHelm's model: instead of the extension hosting the agent, the extension exposes the browser (MCP/CLI/skill) to agents running elsewhere. TabHelm could add an "expose as MCP server" mode without abandoning its ACP-client design.
- chrome-acp's remote/mobile access (QR auth, Termux) is a differentiator none of the bigger projects have, and TabHelm lacks it.

### Gaps
- Browser Use Cloud docs page (webhooks/scheduling/live view) returned 404; cloud scheduling/webhooks not verified from primary source.
- Did not verify which OAuth broker BrowserOS uses for its 40+ apps.

## Privacy and security

### Takeaway
Beyond TabHelm's permissions/confirmations, projects add: domain allow/deny lists with precedence (browser-use), placeholder-based secret substitution so the model never sees credentials (browser-use `sensitive_data`, Stagehand `observe()` claims no sensitive data reaches models, Skyvern injects credentials directly into the browser), per-domain trust levels and sensitive-site categories (agentbrowser, OpenSidekick), destructive-CDP blocking and read-only sessions (browser-control), network-capture credential redaction (browser-control), password-field masking in replays (BrowserOS neo), prompt-injection detection and page sanitization (OpenSidekick, agent-browser-shield, Hermes wraps page content as untrusted), sandboxed compute (peerd WebVM/WASI; OpenHands Docker-per-conversation), and opt-out anonymous telemetry disclosures.

### Cited Findings
- browser-use `allowed_domains` patterns (`example.com`, `*.example.com`, `http*://example.com`), `prohibited_domains`, "Allowed domains take precedence when both are set"; `sensitive_data` dict; v0.13.11 "sensitive data redaction fixes" — [browser params](https://docs.browser-use.com/customize/browser/all-parameters); [agent params](https://docs.browser-use.com/customize/agent/all-parameters); [Releases](https://github.com/browser-use/browser-use/releases). (Dedicated sensitive-data docs page returned 404.)
- Stagehand `observe()` locates elements "using accessibility tree scanning without exposing sensitive data to models" — [README](https://github.com/browserbase/stagehand).
- Skyvern: credentials (passwords, TOTP, payment info) "injected directly into browsers"; Bitwarden/1Password/LastPass — [intro](https://www.skyvern.com/docs/getting-started/introduction).
- agentbrowser: configurable consent gate for click/type/navigate/eval_js; "Per-domain trust levels (trusted domains skip prompts; sensitive domains always ask)" — [README](https://github.com/uni-native/agentbrowser).
- OpenSidekick: sensitive site handling (banking, payments, crypto) requires per-action confirmation; "Prompt-injection detection and domain re-verification"; chat history local only — [README](https://github.com/esterhuizen/opensidekick).
- browser-control: relay blocks cookie/cache clearing and browser close; "Read-only mode: Sessions can reject mouse/keyboard CDP while allowing navigation and inspection"; "Network captures redact credentials; child process output redacted before return"; relay-created pages hidden from other sessions; caveat: "Executes arbitrary agent-provided JavaScript without sandboxing" — [README](https://github.com/anomalyco/browser-control).
- BrowserOS neo: local-only `~/.browserclaw/`, server accepts only 127.0.0.1; password fields masked, canvas excluded from recordings; anonymous telemetry opt-out toggle; v0.51.0 "Removed account requirements; conversations stay on-device" — [audit-and-replay](https://docs.browseros.com/neo/audit-and-replay.md); [privacy](https://docs.browseros.com/neo/privacy.md); [Releases](https://github.com/browseros-ai/BrowserOS/releases).
- BrowserSkill: "The Agent Window inherits the profile's login state—not a separate account or security sandbox" (explicit disclaimer) — [README](https://github.com/Tencent/BrowserSkill).
- Hermes extension: "Page content is wrapped as untrusted context; Cloud/dashboard connections omit sensitive data (credentials, URLs, page text)"; screenshots manual only, never automatic; no autonomous control in Assist mode — [README](https://github.com/abundantbeing/hermes-browser-extension).
- peerd: `peerd-egress` module = vault, network policy, audit controls; scoped keyless actors per page; zero npm runtime deps, vendored pinned third-party code — [README](https://github.com/NotASithLord/peerd).
- agent-browser-shield: PII/credential masking, hidden text/HTML comment suppression against injection — [README](https://github.com/pixiebrix/agent-browser-shield).
- OpenHands: "Multiple Docker sandboxes: Run each new conversation in its own Docker container" — [README](https://github.com/OpenHands/OpenHands).
- Nanobrowser: "Everything runs in your local browser. Your credentials stay with you"; v0.1.12 "Integrated optional anonymous analytics"; "lightweight guardrails" — [README](https://github.com/nanobrowser/nanobrowser); [Releases](https://github.com/nanobrowser/nanobrowser/releases).
- OpenSidebar: BYOK, "no hosted relay or analytics" — [README](https://github.com/krisshkodrani/OpenSidebar).
- UI-TARS-desktop v0.3.1: security release adding access tokens and host validation for remote server exposure — [Releases](https://github.com/bytedance/UI-TARS-desktop/releases).
- LaVague telemetry opt-out via `LAVAGUE_TELEMETRY` — [README](https://github.com/lavague-ai/LaVague).

### Inferences
- Domain allow/deny lists + secret placeholders are the two privacy features with the widest adoption that TabHelm's permission model does not (per the brief) cover.
- A "read-only session" toggle (browser-control) is a cheap trust feature for ACP agents that only need to read pages.

### Gaps
- No project documents redaction of secrets from *logs/exports* explicitly except browser-control's child-process redaction and BrowserOS password masking.

## Community and distribution

### Takeaway
Chrome Web Store presence: Nanobrowser (50k users, 3.6 stars), tactus, OpenSidebar, OpenSidekick; BrowserOS ships as a full browser with separate extension/server release trains (several releases per week in Oct 2026); browser-use and Skyvern maintain docs sites, skills on skills.sh, and cloud pricing; marketplaces/templates: browser-use skills via `npx skills add`, Skyvern workflow builder, BrowserOS "Smart Nudges" + 40-app connector gallery, UI-TARS Agent UI Builder.

### Cited Findings
- Nanobrowser CWS: 50,000 users, 3.6/5 from 66 ratings, last updated Oct 6 2026; CWS version may lag GitHub due to review — [Chrome Web Store](https://chromewebstore.google.com/detail/nanobrowser/imbddededgmcgfhfpcjmijokokekbkal); [stork.ai](https://www.stork.ai/ru/nanobrowser).
- BrowserOS release cadence Oct 5–11 2026: BrowserOS v0.51.0, Agent Extension v0.0.160/161, neo Extension v0.2.34/35, BrowserClaw Server v0.0.67–69 — [Releases](https://github.com/browseros-ai/BrowserOS/releases). Third-party release trackers exist — [releasebot](https://releasebot.io/updates/browseros-ai).
- browser-use: releases roughly monthly (0.13.4 Jul 11 → 0.13.11 Oct 7); Browser Use Benchmark v2 section; $15 cloud credit; skills on skills.sh — [Releases](https://github.com/browser-use/browser-use/releases); [skills overview](https://docs.browser-use.com/open-source/examples/skills/overview).
- Skyvern: 64.4% on WebBench; cloud with proprietary anti-bot — [README](https://github.com/Skyvern-AI/skyvern).
- Stagehand docs versioned v2/v3/v4 — [docs index](https://docs.stagehand.dev/llms.txt).
- tactus "Chrome Web Store: Available"; OpenSidebar CWS id `hakbnbbkiehiofnafdkcibbnkbdmjiha`; OpenSidekick "Available on Chrome Web Store" — [tactus](https://github.com/Castor6/tactus); [OpenSidebar](https://github.com/krisshkodrani/OpenSidebar); [OpenSidekick](https://github.com/esterhuizen/opensidekick).
- Hermes extension on Firefox AMO (chat-only) — [README](https://github.com/abundantbeing/hermes-browser-extension).
- Fellou: $40.4M+ raised; tiers $20–$200/mo — [Cerebral Valley](https://cerebralvalley.beehiiv.com/p/fellou-is-reimagining-the-agentic-browser).

### Inferences
- Nanobrowser's 3.6-star CWS rating with only 66 ratings against 50k users suggests reliability complaints; a comparable TabHelm listing would compete on reliability and on "bring your coding agent" rather than on raw autonomy.

### Gaps
- No HN/Reddit 2026 discussions located for any of the extension projects (search returned aggregators only).
- CWS user counts for BrowserOS extensions, tactus, OpenSidebar, OpenSidekick not retrieved.

## Consolidated gap list for TabHelm (features present elsewhere, absent per brief)

### Takeaway
Ranked by how many credible projects implement it and how directly it maps onto TabHelm's extension architecture.

### Cited Findings
1. Expose the browser as an MCP server / CLI / skill for external coding agents (BrowserOS, mcp-chrome, BrowserSkill, browser-control, page-agent, agentbrowser mcp-proxy) — sources above.
2. Set-of-Marks / labelled screenshots and screenshot diff (OpenHands/BrowserGym, browser-control, browser-use `highlight_elements`) — sources above.
3. Vision mode switch (`auto`/on/off, detail level) and token-budget knobs (history cap, attribute whitelist, paint-order filtering, flash mode) (browser-use) — [agent params](https://docs.browser-use.com/customize/agent/all-parameters).
4. Record → deterministic replay with self-healing / cached actions (workflow-use, Stagehand cache, browser-control `demonstrate()`, OpenSidekick) — sources above.
5. Scheduling in a hidden background window with run history and timeout (BrowserOS; OpenSidekick; Fellou) — [Scheduled Tasks](https://docs.browseros.com/browseros/features/scheduled-tasks.md).
6. Parallel agents each in own colored tab group + live cockpit + searchable audit/replay with per-step screenshots (BrowserOS neo) — [tabs-and-isolation](https://docs.browseros.com/neo/tabs-and-isolation.md); [audit-and-replay](https://docs.browseros.com/neo/audit-and-replay.md).
7. Explicit "human help / handoff" tool for captcha/2FA/WebAuthn and tab-borrowing confirmation (browser-control, BrowserSkill, BrowserOS neo) — sources above.
8. Domain allow/deny lists, secret placeholders (`sensitive_data`), per-domain trust tiers, sensitive-site categories, read-only session, destructive-CDP blocking (browser-use, agentbrowser, OpenSidekick, browser-control) — sources above.
9. Page sanitizer against prompt injection / PII (agent-browser-shield, OpenSidekick, Hermes "untrusted context") — sources above.
10. Dialog tools (`dialog_list/respond`), auto PDF download + markdown rendering, built-in ad-block/cookie-banner extensions, wait tuning, fallback LLM, max_failures (agentbrowser, browser-use) — sources above.
11. OAuth app connectors (40+) with in-chat one-click authorize cards and "smart nudges" (BrowserOS; Fellou) — [connect-mcps](https://docs.browseros.com/browseros/features/connect-mcps.md).
12. MCP *client* inside the extension for extra tools; Agent Skills spec import with script trust (tactus, OpenSidekick) — sources above.
13. Planner/validator role split with per-role models; QA/judge scoring; structured-output schemas (Nanobrowser, Skyvern V2, OpenSidebar, browser-use) — sources above.
14. Prompt templates with slash commands (OpenSidekick); page annotations/comment threads and text-selection "Ask" (agentbrowser, acp-sidepanel quoting, Hermes element pinning); live reversible CSS/HTML patches (agentbrowser) — sources above.
15. Remote/mobile access to the extension-agent bridge (chrome-acp QR/HTTPS, Termux) — [chrome-acp](https://github.com/Areo-Joe/chrome-acp).
16. Semantic vector search across tabs, history and bookmark tools, network capture with response bodies (mcp-chrome) — [README](https://raw.githubusercontent.com/hangwin/mcp-chrome/master/README.md). (TabHelm has cross-tab search; mcp-chrome's is embedding-based with WASM SIMD, which is the "notably better" variant.)
17. Learned reusable "site clients", sandboxed in-extension compute (WebVM/WASI), Global vs Tab memory (peerd, OpenBUA) — sources above.
18. Local shell commands in the working folder (BrowserOS Cowork adds shell to file tools) — [cowork](https://docs.browseros.com/browseros/features/cowork.md).

### Inferences
- Items 1, 5, 7, 8 are the ones most repeatedly validated by active, well-starred 2026 projects and most consistent with TabHelm's ACP-centric design.

### Gaps
- Several claims rest on README text rather than hands-on verification; screenshots were not inspected directly (fetch tool returns text only).
