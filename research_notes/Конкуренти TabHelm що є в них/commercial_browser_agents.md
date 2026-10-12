# Commercial AI browser agents — feature inventory as of 2026-10-12

Scope: Claude in Chrome, OpenAI (Atlas → ChatGPT Work / Chrome extension), Perplexity Comet, Dia (Atlassian), Gemini in Chrome / auto browse, Microsoft Edge Copilot, Opera Neon, Brave Leo, Arc Max. Research done 2026-10-12 via web search + fetch of ~25 pages. Several primary pages (TechRepublic, gHacks, Opera IR, Brave support, Perplexity blog) returned 403/404 to the fetcher; where only search snippets or secondary summaries were available this is flagged "(secondary)". Dates older than ~3 months are marked explicitly.

Date-marking convention: **[2026-xx]** = confirmed date; **(older)** = 2025 fact still believed current; **(uncertain)** = conflicting or weakly sourced.

---

## Key Question 1 — Per-product profile: interaction model, models, pricing, platform

### Takeaway
The market split into two camps after OpenAI killed Atlas (2026-08-09): "agent in your existing Chrome" (Claude in Chrome, Gemini in Chrome, ChatGPT Chrome extension, Brave Leo inside Brave, Edge Copilot inside Edge) and "own Chromium browser" (Comet, Dia, Opera Neon). Side panel is now the universal interaction model; every major vendor charges ~$20/month for agentic features except Comet (free since 2025-10-02) and Brave (free, Nightly-only agent).

### Cited Findings

**Claude in Chrome (Anthropic)**
- Chrome-only extension, side panel; "not supported on other Chromium-based web browsers or mobile devices" — [Anthropic support: Get started with Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
- Timeline: research preview 2025-08-25; Max beta 2025-11-24; Pro/Team/Enterprise 2025-12-18 (older) — [Anthropic: Piloting Claude in Chrome](https://claude.com/resources/articles/claude-for-chrome)
- GA / "automatic approval" mode arrived **2026-08-26**; required plan Pro, Max, Team or Enterprise (no free tier); Enterprise off by default, admins must enable — [ClickForest explainer (secondary)](https://www.clickforest.com/en/blog/claude-in-chrome-explained); the support page's "Launch Date August 26, 2026" and "Beta in Chrome side panel; rolling out to Pro plans" wording — [Anthropic support](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome). **(uncertain: exact meaning of the Aug-26 milestone — GA vs. new Cowork side-panel variant; treat as "GA on all paid plans, 2026-08-26")**
- Models: "available on all public models" — [Anthropic support](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
- Two UI variants exist: a "classic side panel" (has workflow recording) and the newer Cowork side panel (automatic approval default) — [Anthropic support](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome); [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained)
- Claude Code integration: `claude --chrome` and a managed setting `allowClaudeInChromeWithManagedMcp` — [Claude Code changelog](https://code.claude.com/docs/en/changelog)
- Anthropic release notes Jun–Oct 2026 contain no Chrome-specific entries (Chrome ships separately from the main release notes) — [Anthropic release notes](https://support.claude.com/en/articles/12138966-release-notes)

**OpenAI — Atlas (discontinued) → ChatGPT Work + Chrome extension**
- ChatGPT Atlas: macOS-only Chromium browser launched 2025-10-21, **shut down 2026-08-09**; Windows/iOS/Android never shipped; had Agent Mode (paid), Browser Memories (deleted within 7 days), Cursor Chat — [Wikipedia: ChatGPT Atlas](https://en.wikipedia.org/wiki/ChatGPT_Atlas); [TNW](https://thenextweb.com/news/openai-chatgpt-atlas-browser-shutdown-superapp)
- Replacement = **ChatGPT Work**, desktop "super app" merging ChatGPT + Codex + Atlas browsing, launched **2026-07-09** (macOS all plans incl. Free; Windows days later; Linux public preview 2026-08-14) — [TNW](https://thenextweb.com/news/openai-chatgpt-atlas-browser-shutdown-superapp); [AI-Toolbox guide (secondary)](https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-atlas-browser-guide-2026); [DigitalApplied (secondary)](https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026)
- ChatGPT Work desktop: built-in multi-tab Chromium browser (`@Browser`, Cmd+Shift+B), can also drive external browsers via `@Chrome` / `@Edge`; separate **cloud browser on OpenAI servers** for remote agent runs; tabs, password manager, autofill — [TNW](https://thenextweb.com/news/openai-chatgpt-atlas-browser-shutdown-superapp); [AI-Toolbox](https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-atlas-browser-guide-2026)
- **Official ChatGPT Chrome extension** launched alongside, 2026-07-09: side panel in Chrome, Edge, Brave, Opera, Vivaldi; runs on chatgpt.com with full conversation history; Cmd+Shift+. shortcut; requires "reading and changing data on all websites" — [AI-Toolbox](https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-atlas-browser-guide-2026). Search snippets say it "keeps context across multiple tabs, and can navigate the browser on its own" and "asks approval before sensitive actions like accessing new sites" — [Supercharge Browser (secondary)](https://www.superchargebrowser.com/library/openai-chatgpt-chrome-extension-2026/); [Utilengine (secondary)](https://utilengine.com/blog/chatgpt-chrome-extension/)
- Pricing: usage-metered within plan ("longer, more involved tasks consume more of your plan's included usage"), no per-task price; Free/Go get "limited ChatGPT Work access on desktop" — [DigitalApplied](https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026); [AI-Toolbox](https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-atlas-browser-guide-2026)
- Operator: still listed as a distinct product on Wikipedia's template, not documented as the Atlas successor — [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Atlas). **(uncertain: whether Operator still exists as a standalone surface in Oct 2026 — I found no 2026 primary source.)**

**Perplexity Comet**
- Own Chromium browser; sidebar "Comet Assistant"; Mac, Windows, iOS, Android; free for everyone since **2025-10-02** (older) — [eesel pricing summary (secondary)](https://www.eesel.ai/blog/perplexity-comet-pricing); [TechCrunch 2025-10-02](https://techcrunch.com/2025/10/02/perplexitys-comet-ai-browser-now-free-max-users-get-new-background-assistant/)
- Tiers: Free $0 (assistant, summaries, ad block, voice); Comet Plus $5; Pro $20 ($17 annual: 300+ searches/day, all models, Computer credits); Max $200 ($167 annual: Background Assistants, 10k+ credits, Model Council); Enterprise Pro $40/seat; Enterprise Max $325/seat — [eesel](https://www.eesel.ai/blog/perplexity-comet-pricing)
- Rebuilt assistant "mid-2026" launched to all users claiming "23% improvement" on multi-step tasks, longer jobs, cross-tab — [search snippet, source unclear; the-comets-tale newsletter 404'd] **(uncertain)**
- Comet Enterprise launched **2026-03-18**: MDM deployment on macOS/Windows, 500+ Chromium policies, admins can "restrict agent actions, block domains, require approvals", telemetry, audit logs, CrowdStrike Falcon integration; customers named: Fortune, AWS, AlixPartners, Bessemer — [TestingCatalog](https://www.testingcatalog.com/perplexity-launches-comet-enterprise-with-advanced-security/); [ResultSense (secondary)](https://www.resultsense.com/news/2026-03-18-perplexity-launches-comet-enterprise-ai-browser)

**Dia (The Browser Company / Atlassian)**
- Chromium browser; chat in omnibox + right sidebar; macOS public launch 2025-10-09; Atlassian acquisition closed 2025-10-21 ($610M) (older) — [search summary citing Wikipedia/Composite] ; Arc in maintenance mode since May 2025 — [Supercharge Browser (secondary)](https://www.superchargebrowser.com/library/arc-browser-status-2026/)
- **Windows launch 2026-10-07**, shipped as "an early, untested build" not yet "security-tested"; migration tool imports tabs/passwords/bookmarks/extensions; workplace account integration (Slack, Google Workspace, Atlassian) — [PiunikaWeb](https://piunikaweb.com/2026/10/07/dia-browser-windows-launch/)
- Pricing: free tier + Dia Pro $20/month; article mentions corporate AI plans reaching "$100" — [SupaSidebar review (secondary)](https://supasidebar.com/blog/dia-browser-mac-review-2026); [PiunikaWeb](https://piunikaweb.com/2026/10/07/dia-browser-windows-launch/)
- Apple Silicon only (M1+, macOS 14+); no Linux; no iOS app (Safari "Tab Handoff" only) — [SupaSidebar](https://supasidebar.com/blog/dia-browser-mac-review-2026)
- Integrations March 2026: Slack, Notion, Google Calendar, Gmail, Amplitude — [search summary, Composite/Wikipedia (secondary)]
- "Dia for Work" enterprise repositioning in H1 2026; Atlassian founder update 2026-05-06 features Dia (video only) — [Atlassian blog](https://www.atlassian.com/blog/company-news/founder-update-team-26/attachment/dia)
- **No evidence found of Dia features shipping as a Chrome extension**; Dia runs Chrome Web Store extensions, which is the only "Chrome" link.

**Google Gemini in Chrome / auto browse**
- Gemini moved to an always-available right side panel; **auto browse announced 2026-01-28/29**, rolling out to Google AI Pro / AI Ultra subscribers in the U.S. on Windows, macOS, Chromebook Plus — [MacRumors 2026-01-29](https://www.macrumors.com/2026/01/29/google-chrome-gemini-side-panel-ai-features/); [Google blog](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
- Model: Gemini 3 — [Google blog](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
- Android: Gemini in Chrome + auto browse late June 2026 (U.S., Android 12+, 4 GB RAM); iOS has Gemini in Chrome — [Chrome I/O 2026 developer blog](https://developer.chrome.com/blog/chrome-at-io26); [Google blog Android](https://blog.google/products-and-platforms/products/chrome/bringing-chrome-ai-to-android/)
- I/O 2026 (2026-05-19): "Skills in Chrome" (save multi-step workflows, one-click), Selection tool, auto browse to integrate with **Gemini Spark** 24/7 agent (Tasks/Skills/Schedules; Ultra beta $200/mo) — [Chrome I/O blog](https://developer.chrome.com/blog/chrome-at-io26); [Decrypt](https://decrypt.co/368389/google-gemini-spark-ai-agent-challenge-hermes-openclaw); [Gigazine](https://gigazine.net/gsc_news/en/20260520-google-gemini-spark)
- Pricing: Google AI Pro ($19.99 — not re-verified) / Ultra $200/mo (reduced from $250) — [Decrypt](https://decrypt.co/368389/google-gemini-spark-ai-agent-challenge-hermes-openclaw) **(Pro price uncertain)**

**Microsoft Edge Copilot Mode**
- Copilot Mode (Actions + Journeys, persistent side pane, cross-tab reasoning, voice) free in a US preview, Windows/Mac — [eWeek](https://www.eweek.com/news/microsoft-edge-copilot-mode-ai-browser/) (older, 2025)
- **2026-05-15: Microsoft retired "Copilot Mode" as a separate mode; its features (Journeys, tab summaries, Study & Learn, writing assistant, quizzes, tabs-to-podcast, Vision/Voice) moved into default Edge; Journeys now on mobile** — [gHacks headline 2026-05-15 (body 403)](https://www.ghacks.net/2026/05/15/microsoft-edge-retires-copilot-mode-and-integrates-ai-features-across-desktop-and-mobile/); [WindowsForum](https://windowsforum.com/threads/microsoft-retires-copilot-mode-in-edge-ai-features-move-into-default-browsing.418461/)
- **(uncertain: whether Copilot Actions (true agentic clicking) is in stable default Edge or still preview as of Oct 2026 — fetches failed.)**

**Opera Neon**
- Own browser, GA **2025-12-11**, $19.90/month; agents Chat / Do / Make + ODRA deep-research; "Tasks" = self-contained workspaces, multiple projects in parallel; cloud VM lets agents keep working offline; models GPT-5.1, Gemini 3 Pro, Veo 3.1, Nano Banana Pro; Discord community (older) — [Techzine](https://www.techzine.eu/news/applications/137236/agentic-ai-browser-opera-neon-now-generally-available/); [Windows Central](https://www.windowscentral.com/software-apps/opera-is-next-in-line-to-release-an-ai-powered-web-browser-that-costs-money-to-use)
- Neon Do: opens/closes tabs, navigates, compares, fills forms — [Neowin (secondary)](https://www.neowin.net/news/opera-rolls-out-neon-its-first-ai-powered-agentic-browser/)
- Opera's free browsers (One/GX/Air) get "upgraded free, native browser AI tools" (Aria) — [Opera press](https://press.opera.com/?p=3733)

**Brave Leo**
- Free, no account, in-browser (desktop + mobile); models Mixtral, Claude Haiku, Llama 3.1 8B; Premium $14.99/mo (Claude Sonnet 4, 5 devices); BYOM via Ollama/OpenAI APIs; proxied, no server-side retention — [eesel (secondary)](https://www.eesel.ai/blog/brave-leo)
- "AI Browsing" (agentic Leo) announced 2025-12-11 in Nightly; search says early testing "across all Brave release channels in May 2026" but still "Nightly behind an opt-in flag" per prediction market — [Privacy Guides](https://www.privacyguides.org/news/2025/12/12/brave-adds-experimental-agentic-ai-browsing-feature/); [Manifold (secondary)](https://manifold.markets/Velaris/when-will-brave-browsers-leo-have-a) **(uncertain: stable release status)**

**Arc Max**
- Arc in maintenance mode since May 2025; Max features (5-second previews, tidy tabs, tidy downloads) frozen; no product future — [Supercharge Browser](https://www.superchargebrowser.com/library/arc-browser-status-2026/); [Composite (secondary)](https://composite.com/blog/dia-browser-reviews-pricing-alternatives)

### Inferences
- Only Claude in Chrome and the ChatGPT extension are true "agent-in-your-Chrome" extensions competing on TabHelm's exact surface; Gemini is native to Chrome (no install), which is the hardest moat.
- Dia's Windows build (2026-10-07) and Comet going free make the "own browser" camp more credible for consumers, but every own-browser product has had to add enterprise MDM to monetise.

### Gaps
- Exact plan availability and price of the ChatGPT Chrome extension's agentic features (vs. plain side-chat) — OpenAI help pages not fetched.
- Edge Copilot Actions stable status in Oct 2026.
- Dia Pro/Dia for Work pricing from a primary source.

---

## Key Question 2 — Feature inventory vs. TabHelm (distinctive features TabHelm lacks)

### Takeaway
Features now common across 3+ competitors that TabHelm lacks: **scheduled/recurring tasks** (Claude, Comet Max, ChatGPT Work, Gemini Spark), **cross-session memory** (Claude, Dia, ChatGPT, Gemini "Personal Intelligence"), **password-manager login hand-off** (Claude+1Password, Gemini+Google Password Manager, ChatGPT Work), **saved prompt shortcuts / skills with a slash trigger** (Claude, Dia, Gemini), **parallel background agents** (Comet, Opera Neon, ChatGPT cloud browser), **mobile** (Gemini, Comet, Edge), **enterprise admin allow/deny lists** (Claude, Comet, ChatGPT Work).

### Cited Findings — feature matrix (✓ = shipped, β = beta/preview, — = not found)

| Feature | Claude in Chrome | ChatGPT (Work + ext.) | Comet | Dia | Gemini in Chrome | Edge Copilot | Opera Neon | Brave Leo |
|---|---|---|---|---|---|---|---|---|
| Side panel bound to tab | ✓ | ✓ | ✓ | ✓ (+omnibox) | ✓ (since 2026-01) | ✓ | ✓ | ✓ |
| Multi-tab / tab group | ✓ own tab group | ✓ multi-tab browser | ✓ cross-tab | ✓ Live Groups | ✓ side-panel parallel | ✓ cross-tab | ✓ Tasks workspaces | — |
| Scheduled / recurring | ✓ daily/wk/mo/yr | ✓ recurring + event-triggered + continuous | ✓ Max only | — | β via Spark (Ultra) | — | — | — |
| Memory across sessions | ✓ (account memory, editable Topics 2026-08-25) | ✓ account Memories | — (not found) | ✓ Memory Search v1.4 | β Personal Intelligence | Journeys (history clusters) | — | — |
| "Watch this page" / monitoring | — | ✓ "continuous monitoring" | ✓ price tracking (Max) | — | — | — | — | — |
| Form autofill / saved profiles | ✓ fills forms | ✓ autofill | ✓ form fill | — | ✓ fills forms | ✓ fills forms | ✓ Neon Do | — |
| Password-manager hand-off | β 1Password (macOS) | ✓ built-in PM | — | — | ✓ Google PM w/ permission | — | — | — ("never input credentials") |
| Shopping/booking flows | ✓ (stops before purchase) | ✓ | ✓ | — | ✓ (pauses at purchase) | ✓ Actions reservations | ✓ | — |
| Per-site permissions UI | ✓ site-level | ✓ asks before new sites | Enterprise: domain blocks | — | — | — | — | profile isolation |
| Approval modes | 3 modes (manual / auto w/ classifier / skip) | Plan mode + configurable check-ins | require approvals (Ent.) | — | pause for confirmation | — | — | alignment checker |
| Video / replay | workflow recording (classic panel) | — | progress dashboard | — | — | — | — | — |
| Saved shortcuts / skills | ✓ `/shortcuts` | ✓ 1,400 plugins | — | ✓ Skills | ✓ Skills in Chrome (I/O 2026) | — | ✓ Make (apps) | — |
| Cloud / headless execution | — (Chrome must be open) | ✓ cloud browser | ✓ background assistants | — | Spark (24/7) | — | ✓ cloud VM | — |
| Mobile | — | ✓ web/mobile ChatGPT | ✓ iOS/Android | — | ✓ Android/iOS | ✓ Journeys mobile | — | ✓ |
| Enterprise admin | ✓ org toggle, allow/block lists | ✓ workspace defaults, Compliance API | ✓ MDM, 500+ policies, audit | Dia for Work (unreleased) | — | — | — | — |
| Pricing | paid plans only | usage-metered in plan | free; $200 for background agents | free / $20 | AI Pro/Ultra | free | $19.90 | free / $14.99 |

Sources per row:
- Claude: scheduling, shortcuts, tab group, background workflows, 1Password beta, site restrictions, saved conversations — [Anthropic support](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome); three approval modes, console/network/DOM access, blocked actions — [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained); schedule requires Chrome open — [Fast.io guide (secondary)](https://fast.io/resources/claude-browser-extension-guide/); memory as editable Topics 2026-08-25 — [Anthropic release notes](https://support.claude.com/en/articles/12138966-release-notes)
- ChatGPT Work: plan mode, configurable check-ins, scheduled tasks "recurring, event-triggered, or continuous monitoring", built-in multi-tab browser, cloud browser, 1,400 plugins, Compliance API — [DigitalApplied](https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026); password manager + autofill — [TNW](https://thenextweb.com/news/openai-chatgpt-atlas-browser-shutdown-superapp)
- Comet: background assistants run in parallel, schedulable ("8:30 AM" email summary), progress dashboard — [TechCrunch 2025-10-02](https://techcrunch.com/2025/10/02/perplexitys-comet-ai-browser-now-free-max-users-get-new-background-assistant/); [gend.co](https://www.gend.co/blog/perplexity-comet-ai-browser-free); enterprise controls — [TestingCatalog](https://www.testingcatalog.com/perplexity-launches-comet-enterprise-with-advanced-security/)
- Dia: Skills (v1.2.0), Memory Search (v1.4.0), Tab Groups for Meetings (v1.14.0, 2026-01-14), Live Groups — [SupaSidebar](https://supasidebar.com/blog/dia-browser-mac-review-2026)
- Gemini: pauses before purchase/post, Google Password Manager, side-panel parallel work, Connected Apps — [Google blog](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/); Skills/Spark — [Chrome I/O blog](https://developer.chrome.com/blog/chrome-at-io26)
- Edge: Actions, Journeys, history access off by default — [eWeek](https://www.eweek.com/news/microsoft-edge-copilot-mode-ai-browser/)
- Opera: Tasks, cloud VM, Make — [Techzine](https://www.techzine.eu/news/applications/137236/agentic-ai-browser-opera-neon-now-generally-available/)
- Brave: separate profile, alignment checker — [Privacy Guides](https://www.privacyguides.org/news/2025/12/12/brave-adds-experimental-agentic-ai-browsing-feature/)

### Where a competitor does a TabHelm-existing feature notably better
- **Permission modes:** Claude's "automatic approval" uses a *classifier* that checks each action against the user's request rather than a static allow list — [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained). TabHelm's auto-approve is per-action-type; no semantic check.
- **Tab groups:** Claude spawns its *own* tab group and keeps working in the background while the user switches tabs — [Anthropic support](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome). TabHelm shares a tab group but does not isolate agent tabs.
- **Parallelism:** Comet (multiple background assistants at once) and Opera Neon (multiple Tasks) run several agents simultaneously — [TechCrunch](https://techcrunch.com/2025/10/02/perplexitys-comet-ai-browser-now-free-max-users-get-new-background-assistant/); [Techzine](https://www.techzine.eu/news/applications/137236/agentic-ai-browser-opera-neon-now-generally-available/). TabHelm = one chat per tab.
- **Skills:** Dia and Chrome let users author skills in-product (NL skill builder / chrome://skills); TabHelm only imports skills from links — [SupaSidebar](https://supasidebar.com/blog/dia-browser-mac-review-2026); [Chrome Unboxed](https://chromeunboxed.com/gemini-in-chrome-is-getting-skills-as-it-moves-toward-becoming-a-full-ai-agent/)
- **Developer tools:** Claude in Chrome exposes console logs, network requests and DOM like TabHelm — parity, not better — [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained)

### Inferences
- TabHelm's unique angle (multi-vendor CLI agents over ACP, cost stats, hand-over/failover) is matched by nobody; the ChatGPT extension's `@Chrome`/`@Edge` external-browser driving is the closest analogue to "a terminal agent driving the browser".
- The biggest "table stakes" gaps are scheduled tasks and account memory; both exist in at least four products.
- "Pause and take over" controls were not explicitly documented for any product beyond Gemini's "hands control back" and ChatGPT's plan-mode check-ins; this may be an opportunity rather than a gap.

### Gaps
- No product page found documenting a user-facing "pause / take over / resume" control; only confirmation pauses.
- Comet memory / Personal Search features in 2026 not verified.
- Whether Claude's workflow recording is video or step replay is not specified in sources.

---

## Key Question 3 — Safety UX shipped

### Takeaway
Anthropic publishes the most detailed safety design (site-level permissions, blocked categories, action-confirmation list, classifier-based auto-approve, prompt-injection numbers); Google and OpenAI rely on "pause before money/post" plus approval gates; Brave uses profile isolation and an alignment checker; Comet Enterprise ships admin domain blocks and approval requirements.

### Cited Findings
- Claude: site-level permissions; confirmations required for publishing, purchasing, sharing sensitive data; default-blocked categories financial services, adult, piracy; "advanced classifiers" for suspicious instructions; enterprise allow/block lists — [Anthropic: Piloting Claude in Chrome](https://claude.com/resources/articles/claude-for-chrome)
- Claude will not: make purchases/financial transactions, create accounts, bypass bot verification, place investment trades, permanently delete files — [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained)
- Claude prompt-injection numbers: 23.6% → 11.2% attack success (123 cases) with mitigations; browser-specific hidden-field/URL/tab-title attacks 35.7% → 0% (older, Aug 2025) — [Anthropic](https://claude.com/resources/articles/claude-for-chrome); adaptive eval Opus 4.5: 1.4% at 100 attempts vs 10.8% Sonnet 4.5 (older) — [VentureBeat (secondary)](https://venturebeat.com/infrastructure/anthropic-launches-claude-for-chrome-in-limited-beta-but-prompt-injection-attacks-remain-a-major-concern); **Opus 4.8 (released 2026-05-28): 31.5% hijack rate *before* safeguards, 84% on Online-Mind2Web; post-safeguard rate undisclosed** — [WinBuzzer 2026-06-02](https://winbuzzer.com/2026/06/02/anthropic-reveals-315-browser-agent-hijack-rate-xcxwbn/); 2026 testing claim "with probes plus a safety classifier, not a single attack succeeded" — [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained)
- Gemini auto browse: pauses and asks confirmation before purchases / social posts; "entirely new defenses" against threats; keeps user informed during task — [Google blog](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
- ChatGPT Work: auto-review of actions involving connected tools; OpenAI claims it "blocked 100% of attempts to extract protected data" in red teaming; network-access policies; admin control over agent access/tools — [DigitalApplied (secondary)](https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026)
- Brave: dedicated isolated profile (no cookies from main session), Claude Sonnet + secondary "alignment checker" that never sees raw page content, blocks internal pages, non-HTTPS, Chrome Web Store, flagged sites; Brave calls agentic browsing "inherently dangerous" — [Privacy Guides](https://www.privacyguides.org/news/2025/12/12/brave-adds-experimental-agentic-ai-browsing-feature/)
- Comet: "CometJacking" vulnerabilities disclosed Aug 2025; CEO said browsing data is used for ad profiles (older) — [eesel](https://www.eesel.ai/blog/perplexity-comet-pricing); Enterprise: restrict agent actions, block domains, require approvals, audit logs — [TestingCatalog](https://www.testingcatalog.com/perplexity-launches-comet-enterprise-with-advanced-security/)
- Edge: visual indicator when Copilot is active/listening; browsing-history access off by default — [eWeek](https://www.eweek.com/news/microsoft-edge-copilot-mode-ai-browser/)
- Independent: 793-episode browser benchmark on domain-conditioned safety in frontier CUAs (arXiv 2606.05233, June 2026) — [arXiv](https://arxiv.org/pdf/2606.05233) (not read in full)

### Inferences
- A per-site allow/deny UI plus a *category* blocklist (banking/adult/piracy) is now the expected baseline; TabHelm has per-action permissions but no site/category layer.
- Numbers show even best-in-class agents sit at ~1–11% injection success under adaptive attack; vendors increasingly disclose pre-safeguard rates, so TabHelm could differentiate by surfacing which backend agent/model is in use and its known safety profile.

### Gaps
- Post-safeguard rate for Opus 4.8 not published.
- No safety documentation found for Opera Neon or Dia.

---

## Key Question 4 — Published numbers and recent launches (Sept–Oct 2026)

### Takeaway
Few vendors publish user counts; benchmark leaders are specialist automation companies, not the consumer browser agents. The notable Sept–Oct 2026 events are Dia on Windows (10-07), Claude Haiku 5.5 (10-07), Claude Cowork unification (09-16), and the Atlas shutdown aftermath (08-09).

### Cited Findings
- WebVoyager (643 tasks, 15 sites): Surfer 2 97.1%, Magnitude 93.9%, AIME 92.3%, Browserable 90.4%, Browser Use 89.1%, OpenAI Operator 87.0%, Skyvern 2.0 85.9%, Google Project Mariner 83.5% (early 2026) — [AgentMarketCap 2026-04-13](https://agentmarketcap.ai/blog/2026/04/13/browser-agent-benchmark-saturation-webvoyager-97-percent-2026); [Steel leaderboard](https://leaderboard.steel.dev/results)
- BrowseComp (as of 2026-06-02): GPT-5.5 Pro 90.1%, GPT-5.4 Pro 89.3%, Claude Mythos Preview 86.9% — [BenchLM](https://www.benchlm.ai/benchmarks/browseComp)
- Online-Mind2Web: Claude Opus 4.8 browser agent 84% — [WinBuzzer](https://winbuzzer.com/2026/06/02/anthropic-reveals-315-browser-agent-hijack-rate-xcxwbn/)
- OpenAI usage: 5M+ weekly Codex users, 1M+ non-developers — [DigitalApplied (secondary)](https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026)
- Comet Enterprise Product Hunt: 125 upvotes, #14 daily (2026-03-18) — [search snippet, hunted.space (secondary)](https://www.hunted.space/product/perplexity-ai/launches/comet-for-enterprise)
- Recent launches: Dia Windows 2026-10-07 — [PiunikaWeb](https://piunikaweb.com/2026/10/07/dia-browser-windows-launch/); Claude Haiku 5.5 2026-10-07, Google Workspace connectors 2026-10-01, plugin directory 2026-09-25, Cowork unified 2026-09-16, Fable 5.1 / Mythos 5.1 2026-09-01 — [Anthropic release notes](https://support.claude.com/en/articles/12138966-release-notes); ChatGPT Work Linux preview 2026-08-14 — [AI-Toolbox](https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-atlas-browser-guide-2026); Claude in Chrome auto-approve 2026-08-26 — [ClickForest](https://www.clickforest.com/en/blog/claude-in-chrome-explained)

### Inferences
- No consumer browser agent publishes WebVoyager/WebArena scores for its shipped product; benchmark leadership is irrelevant to the consumer comparison except as marketing.

### Gaps
- No user counts for Claude in Chrome, Comet, Dia, Gemini auto browse, Opera Neon, or Edge Copilot were found in any source.
- No primary (vendor) Sept–Oct 2026 release notes for Comet, Gemini in Chrome, Edge or Opera were retrievable; the September 2026 Comet "rebuilt assistant" claim rests on a search snippet only.
