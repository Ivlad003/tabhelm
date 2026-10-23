# Changelog

All notable changes to TabHelm. The newest release is at the top; the panel's update banner links here.

## [0.31.0] - 2026-10-23

### Added
- **Self-analysis** (Experimental flag): TabHelm looks back at your chats and explains what went wrong and why — a TabHelm bug, site knowledge or a skill the agent was missing, the agent, your setup or the site.
  - **Diagnose this chat** (＋ menu, `/diagnose [what went wrong]`, or **Diagnose** when a task fails): the top causes, what is happening right now (a question waiting for you, a stuck agent, the host offline) and one-click fixes — open the right setting, draft a skill or a site note from what failed and what worked, switch agents.
  - **Report** (History → Report, `/report`): every chat of the last 7 / 30 / 90 days, findings grouped by who can fix them, "fix these first", tool and agent tables; hidden findings come back only if they grow, ones that stopped happening move to *Probably fixed*.
  - **Copy bug report**, **Copy as a fix task**, **Export .md / .json** and **Ask the agent…** — always previewed first, redacted: no messages, typed text, page content, titles, full URLs, file paths or secret values; site and skill names become `site-1`, `skill-1`. The issue page opens with an empty URL.
  - The agent can run its own self-check with `tabhelm_diagnose` (this chat; other chats only after you allow it).
  - Uses a redacted digest of `host.log` (crashes, agent sign-in problems, relay errors) — the host never sends raw log lines.
- `npm run test:selfanalysis` (237 unit tests, including canary values that must never appear in any output); `npm run test:flags` covers Diagnose, `/report`, the agent's self-check and the bug-report preview.

### Fixed
- **A reopened chat could stop saving.** Reopening a chat that contained an approval or a question card threw while replaying it, and the chat silently stopped being saved; exporting such a chat to Markdown failed too.
- **The agent was not told that your skills changed** when other start-up notes (secrets, single-tab mode) were also due.
- **Scheduled runs waited 15 minutes when the agent asked for permission.** They now decline at once and save "needs approval (scheduled runs cannot ask)"; a confirmation with no panel to answer it says so instead of looking like your "no".
- Agents are offered only the tools of features that are on (Developer tools, Page scripts, Take over, Password manager, Memory), instead of tools that answer "this feature is off". Turning one on applies from the next chat.
- The panel closing, **New chat** or opening another chat mid-task now records how the task ended (cancelled / panel closed); errors in the panel itself are kept with the chat (redacted) for the self-analysis.
- The agent picker no longer jumps to another agent while one is connected (it did when another panel started a new chat), so a model you pick is saved for the agent that is actually answering.
- `host.log` is rotated at 5 MB (one old copy, `host.log.1`) and each line carries the host's process id.
- Tests write their own host log instead of `~/.tabhelm/host.log`.

## [0.30.0] - 2026-10-21

### Added
- **Skip waiting in recordings** (Experimental flag, with how much of each wait to keep): still stretches — loading, the agent thinking — are cut from the video and marked "⏩ N s of waiting skipped". A 45 s task typically becomes a ~10 s video; step lists still seek to the right moment.

### Fixed
- **Recordings could not be seeked and did not preview in Slack.** MediaRecorder writes a streaming (fragmented) file with a keyframe only every ~20 s. Videos are now encoded with WebCodecs into a regular H.264 MP4 with its index at the start (fast start) and a keyframe every 2 s; the encoder also keeps working while the side panel is hidden. (Vendored `mp4-muxer`, MIT.)
- **Back after the agent opened another page could land on about:blank** — Chrome skips pages left without a click — **and the agent was then stuck** ("Chrome does not allow extensions to control about:blank"). Navigation now works from any page, and Back returns to the page the agent came from.
- Tests no longer read or overwrite the user's `~/.tabhelm/state.json` (the e2e test keeps the host's backup in its own profile).
- End-to-end tests no longer fetch the live news feed (a banner appearing mid-test shifted the Settings layout under a click).

## [0.29.1] - 2026-10-21

### Changed
- **Guide auto-play is a setting:** Settings → Page → *Auto-play guides*. On: every guide plays by itself with no prompt. Off: guides wait for you (the agent is told why if it asked for auto-play) and ▶ Auto plays a single guide. The per-guide "Play this guide automatically?" prompt is gone.

### Fixed
- Guide steps for fields inside a `<label>` show the label text ("Color"), not the field's options.

## [0.29.0] - 2026-10-21

### Added
- **Work in one tab** (Settings → Page, or ＋ → Stay in this tab): the agent stays in the chat's tab — no new tabs or switching; "open in a new tab" and pop-ups load in this tab.

### Fixed
- **Pressing Send jumped to the last tab of the chat's group** when Record video was on: recording started on the agent's last tab and pulled it to the front. It now records the tab you are looking at and never switches on Send; each new message also makes that tab the agent's default.
- **Guide auto-play did not start when the agent asked for it** (the tool schema dropped `auto`), and it could only click. Steps now have an action — click, type a value, select an option, check — performed by auto-play; in manual mode typing steps complete when the value changes.
- **Messages typed while the agent works were treated as prompt injection** (they arrived inside a tool result). Enter now interrupts the current step and sends the message as a normal user message asking the agent to continue.
- **Recording across tabs** now also follows the agent when it only reads another tab, so the video shows every tab it works with.
- **Guide scrolling:** each step's element is scrolled into view smoothly whenever it is not comfortably visible (with room for the arrow and the bubble), so recordings show where the guide goes next.
- Voice (Chrome recognition): a result arriving just after Stop no longer throws in the panel (found by the monkey test).

## [0.28.0] - 2026-10-21

A feature release that rounds up everything since 0.19. No code changes since 0.27.3 beyond the panel's news: the update banner and five news items now announce these features in the panel and on the website.

### Highlights since 0.19
- **Remote host through your own relay** (0.25) — agents on a VPS or another PC, paired with a code; relay ready for Dokploy.
- **Guide mode** (0.21–0.27) — the agent marks every step on the page; Next / Back across steps and tabs; ▶ Auto plays it with pauses; Detailed guide flag.
- **Pick element / Select area** and **Page scripts & styles** (0.27) — hand exact elements to the agent; a library of CSS/JS presets run from ＋ or automatically.
- **Context meter**, **messages while the agent works**, **Copy / Text** under replies (0.24–0.26).
- **Skills** from whole repositories, skills made from a chat (0.21–0.23).
- **History** survives reinstalling the extension; delete one chat or all (0.19).
- **Reliability**: Auto-approve covers routine confirmations, recording follows the agent across tabs and never comes out empty, voice keeps the last words, no lost messages after New chat; a monkey test (`npm run test:monkey`) and a full smoke / e2e pass (0.27.1–0.27.3).

## [0.27.3] - 2026-10-20

### Fixed
- **Voice: the last words before Stop were lost.** The recorder's final chunk arrives after Stop, but the text was delivered before it was transcribed (and a late chunk could throw in the panel). The final chunk is now transcribed and included, exactly once.
- **Microphone permission:** after you press *Allow microphone* on the one-time page, it closes, takes you back to your tab and the recording you asked for starts by itself — no second click.
- **Video recording on still pages and hidden windows:** the screencast only sends frames when the page repaints, so a still page or an occluded window gave a choppy or empty video. Recording now brings the tab forward, captures the first frame right away and fills silences with screenshots (about 2 frames a second); a task that ends instantly gets a clear note instead of an error.
- **Tab groups in pop-up / app windows:** a clear message (open the page in a regular window) instead of Chrome's "Grouping is not supported".

## [0.27.2] - 2026-10-20

Fixes from a full smoke / end-to-end / monkey test pass (`npm run test:monkey` is new).

### Fixed
- **Relay crash:** one oversized or malformed WebSocket frame from any client — even without the key — took the whole relay down. Socket errors now close only that socket.
- **Relay rate limit** used the first `X-Forwarded-For` entry, which a client can forge; it now uses the address the proxy appends.
- **Path traversal in recordings:** the recording id was used in a file name unchecked; ids are now validated so nothing can be written outside the recordings folder.
- **Lost messages after New chat / switching agents:** a message sent while the new agent was still starting could overtake the start and fail with "No agent is connected" or "Invalid params". Messages now wait for the start (and for sign-in) to finish.
- Stopping, New chat or switching agents during a reply no longer shows a red "ACP connection closed" error.
- Changing the model while the agent is starting no longer fails with "No agent session"; the choice is applied once the session is ready.
- Browser tools return clear "Invalid arguments" errors instead of internal TypeErrors (`browser_fill_form`, `browser_highlight` and any tool given wrong argument types); the host ignores non-object messages and validates `critic` / `save_recording` input.
- Clearer texts: no more "press Connect" (there is no Connect button), and tab-audio capture explains that the TabHelm icon must be clicked on that tab first.
- The end-to-end test runs against built releases (it no longer needs the stripped test hook).

## [0.27.1] - 2026-10-20

### Fixed
- **Auto-approve now covers TabHelm's own routine confirmations** — JavaScript on the page, using another tab, cookies/storage changes, saved scripts, guide auto-play — and logs them as *✓ Auto-approved* steps. Uploading files from disk and the opt-in safety gates (sensitive actions, site rules, critic) still ask.
- **Recording follows the agent across tabs:** when the agent acts on another tab (also via `tabId` without switching), that tab comes to the front and the video continues there; before, background tabs were not captured.

## [0.27.0] - 2026-10-15

### Added
- **Guide auto-play:** ▶ Auto in a guide lets the agent click each step itself after a pause (Settings → Page); ⏸ Pause takes over again. The agent can offer it with `auto: true` after you agree.
- **Pick element** and **Select area** in the ＋ menu: pick one element by clicking or many by dragging a rectangle; they go into your message with refs, CSS selectors, text and HTML.
- **Page scripts & styles** (Experimental flag): a library of CSS / JS presets with URL patterns — run from the ＋ menu on any page, or automatically on matching pages; agent tools `browser_style`, `browser_script_save`, `browser_script_list`, `browser_script_run`.

### Fixed
- The context meter no longer shows an empty "ctx" button before the agent reports usage.

## [0.26.1] - 2026-10-14

### Added
- **Copy** / **Text** buttons under every agent reply: Markdown source, or plain text with links written out as *label (url)* (and rich text with clickable links for docs and mail).

## [0.26.0] - 2026-10-14

### Changed
- **Guide mode is a tour:** the agent passes all steps at once; every step gets a numbered badge on the page, Next / Back move between them (scrolling to the element, switching tabs for steps on other tabs), Finish ends the guide. One panel card follows the tour instead of one card per step.

## [0.25.1] - 2026-10-14

### Changed
- The tab the agent works on is grouped from its first task: a *TabHelm* tab group that is yellow with ⏳ while a task runs and green when it is done, so the agent's tab stands out in the tab strip.

## [0.25.0] - 2026-10-13

### Added
- **Remote host through your own relay.** `relay/` is a ~150-line WebSocket relay (Dockerfile, `RELAY_KEY`, ready for Dokploy). Run the host anywhere with `npm run relay -- wss://relay.example.com --key …`, enter the printed pairing code in **Settings → Remote host**, and the panel drives that machine's agents — outbound connections only, no SSH or open ports. `host/Dockerfile.agent` packages the host with OpenCode and Claude Code for running agents on the VPS itself.

## [0.24.0] - 2026-10-13

### Added
- **Context meter** in the header: how full the context window is; click for details — used / left / window size, this chat's tokens (input, output, cached, reasoning), cost, time and the last task. Amber at 80 %.
- **Messages while the agent works:** Enter queues a message; it reaches the agent with its next browser step (or is sent as the next message if the task ends first).

## [0.23.0] - 2026-10-13

### Added
- Settings → Skills accepts a link to a whole repository or folder of skills (e.g. `github.com/mattpocock/skills`): a picker lists every `SKILL.md` with its description; filter, select and add them in one go.

### Fixed
- Settings buttons pressed right after the panel opened could be ignored while stored settings were still loading.

## [0.22.1] - 2026-10-13

### Added
- Guide steps have a **← Back** button (from step 2 on) that asks the agent to show the previous step again.

## [0.22.0] - 2026-10-13

### Added
- **Detailed guide** flag (Settings → Experimental): in guide mode the agent explains each step in a few sentences — what the element is, why, what happens after the click, what to check.
- Guide steps have a **Next →** button (on the page and in the panel) to move on.

### Fixed
- The guide overlay now scrolls with the page instead of jumping into place after scrolling stops.

## [0.21.1] - 2026-10-13

### Changed
- Tabs the agent opens (and pop-ups from its clicks) are always put into the chat's green *TabHelm* tab group, creating it if needed, so the agent's tabs are distinguishable from yours. The panel's group counter updates as tabs join or leave.

## [0.21.0] - 2026-10-13

### Added
- **Guide mode:** ask to be shown how ("guide me through setting up…") and the agent walks you through it step by step — an arrow and instruction appear on the page next to the element and the agent waits for your click (or *I did it* / *Skip* on the page or in the panel). Recordings include the arrows.
- **Make a skill from this chat** (＋ menu): the agent distils what was done — including guide steps — into a reusable skill saved with the new `skill_save` tool; it appears in Settings → Skill authoring and runs with `/name`.

## [0.20.0] - 2026-10-13

### Added
- **Highlight finds:** when the agent searches the page (`browser_find`), the matches are outlined on the page for a few seconds and the first one is scrolled into view. Switch it off in Settings → Page.

## [0.19.4] - 2026-10-13

### Added
- History: 🗑 deletes one chat (with confirmation) and *Clear all* removes every saved chat except the one that is open.

## [0.19.3] - 2026-10-13

### Fixed
- **Chat history survives reinstalling the extension.** The host keeps a copy of the panel's storage (chats, settings, skills — never secrets) in `~/.tabhelm/state.json` and restores it when the extension starts with empty storage.

## [0.19.2] - 2026-10-13

### Fixed
- Agent replies render full Markdown: headings, nested and numbered lists, task lists, block quotes, tables, rules, italics and bare links (previously only paragraphs, bold, code and links).

## [0.19.1] - 2026-10-13

### Fixed
- **Windows: agents installed by npm (Cursor `agent`, Kilo, Cline, …) failed with `spawn EINVAL`.** Node 20.12+ refuses to start `.cmd`/`.bat` files directly; the host now launches them through cmd.exe.

## [0.19.0] - 2026-10-13

### Added
- **Page selection and images in the chat:** right-click → *Add selection / Add image to TabHelm chat*, Alt+Shift+T, or ＋ → *Add page selection*. The panel opens and the quote (with the page address) or image is sent with your next message.

## [0.18.0] - 2026-10-13

### Added
- **Windows installer:** `irm https://ivlad003.github.io/tabhelm/install.ps1 | iex`. The native host is registered in the registry (HKCU) for Chrome, Edge, Chromium and Brave and started through a `.cmd` wrapper; agents are found via PATHEXT; the folder picker uses a PowerShell dialog; registry agents unpack with `tar`.

## [0.17.1] - 2026-10-13

### Fixed
- The model is visible before the agent is connected (last choice; clicking it connects and loads the list) and can also be changed in Settings → Model options.

## [0.17.0] - 2026-10-13

### Changed
- **Simpler panel.** No Connect button: the agent starts with your first message; changing the agent mid-chat hands the conversation over. The status shows words only while starting, working, paused or on errors.
- One **＋ menu** in the composer holds attachments, voice, video recording, tab sharing and the working folder; the folder and tab rows became chips that appear only when relevant.
- Effort and other agent options moved to **Settings → Model options**; the model stays next to the agent.
- **Export** moved into History (any chat, Markdown or JSON); the top bar is History · Settings · New chat.
- Agent permission cards and TabHelm confirmations now look and read the same (Allow once / Reject).
- Written skills live in the Skills section next to skills from links.
- Update and news banners are one line each and unfold on click.

## [0.16.0] - 2026-10-13

### Added
- **Voice** (experimental, off by default): record a voice message from the microphone or capture the tab's audio, transcribed live; on Stop the transcript becomes one editable message. Engines: Chrome speech recognition (microphone), whisper.cpp or an OpenAI-compatible transcription API on the host.

### Changed
- One **Folder…** button with a menu (system dialog, recent folders, type a path) replaces the Folder/Path pair.

## [0.15.0] - 2026-10-13

### Added
- **Settings → Experimental** — thirteen features, all off by default: action critic (second model vets each action), site rules (categories + deny/allow lists), sensitive-action gate, plan preview, take over (pause/resume + `browser_request_human`), scheduled tasks, developer tools (`browser_fill_form`, `browser_network_body`, `browser_storage`, `browser_emulate`, `browser_highlight`), secrets (`{{SECRET:name}}` placeholders), memory across chats (`memory_save` / `memory_search`, `~/.tabhelm/memory.json`), skill authoring with `/` slash commands, password-manager hand-off (`browser_request_login`: 1Password CLI or Chrome's passwords), action database (jump-to-step in recordings, step search in History), notifications (tab badge + system notification).
- Policy layers run in the extension before a tool executes, so they cover every agent.
- `npm run test:flags`: all features exercised with the built-in agent against a scripted mock model.

### Changed
- Only this extension's own pages may connect to the service worker (hardening).
- Tool calls may wait up to 30 minutes (take-over pauses, human help).

## [0.14.0] - 2026-10-12

### Added
- **Several tabs per chat.** *Group tabs* puts the chat's tab in a Chrome tab group; tabs dragged into the group are shared with the agent without approval, tabs dragged out stop being shared. Agent-opened tabs join the group; the TabHelm icon on a grouped tab opens the chat.
- Every page tool accepts `tabId` to act on another tab without switching; new `browser_search_tabs` searches all tabs the agent can use. Moving data between tabs and searching across tabs work in one task.

### Changed
- Pop-ups are handed to the agent only when they open while it is acting; tabs the user opens from the same page stay the user's.

## [0.13.0] - 2026-10-12

### Added
- **Design system** in soft emerald tones (`design/tokens.css` + guide), shared by the side panel and the website, light and dark; new emerald logo and icons.
- **Steps block:** the agent's actions and its own tool calls (e.g. tool search) and thinking are grouped into one scrollable message per run, with a step count.
- **History:** chats are saved and listed with search; opening a chat switches to its tab (or brings the current tab back to its page) and any agent can continue it. Reopening the panel restores the tab's chat.

### Fixed
- A chat reopened while the agent was still starting could lose its context; any fresh agent session in a chat with history now gets that history with its first message.

## [0.12.0] - 2026-10-12

### Added
- **Working folder** for a chat (optional): pick it with the system dialog or type a path. Agents start there, follow the project's AGENTS.md / CLAUDE.md, and can create files, write code and run scripts; the project's skills are added for every agent. Changing the folder restarts the agent with the conversation handed over.
- **Task stats** under every answer: time, and tokens, cost and context use when the agent reports them. Totals in the Markdown export.
- **Delete** button for recordings (removes the video from the chat and from disk).
- The built-in agent reports tokens and OpenRouter cost.

## [0.11.0] - 2026-10-12

### Added
- **Attachments in the chat:** images and text files (txt, md, csv, tsv, json, log) via the Attach button, drag and drop, or pasting an image. Images are downscaled to 1600 px.
- Agents receive images and files over ACP where they support it; otherwise images are saved into the agent's workspace and text is put inline. The built-in agent sends images to vision models.
- Attachments appear in the sent message, the hand-over context and the Markdown export.

## [0.10.0] - 2026-10-12

### Added
- **Kilo Code**, **Cline** and **CodeBuddy Code** agents — all three have free tiers. Kilo starts on `kilo-auto/free` and completed the browser test without signing in.
- `npm run install-agent -- <name>` installs **any** agent from the ACP registry; TabHelm lists installed agents automatically.
- README section "Free options" with the free tiers checked in October 2026.

## [0.9.0] - 2026-10-12

### Added
- **Settings** view in the side panel.
- **Skills from links:** paste a link to a `SKILL.md` file or a skill folder on GitHub; TabHelm loads it (cached for an hour) without installing anything. Agents see each skill's description and read it with the new `skill_list`, `skill_read` and `skill_read_file` tools. Works with every agent, including the built-in one.
- Settings show the extension and native host versions, warn when they differ, and have a **Check for updates** button.
- Website shows the latest version, release date and news; release notes come from this changelog.

### Changed
- The update feed is cached for 1 hour instead of 6; a manual check shows a dismissed update banner again.

## [0.8.1] - 2026-10-12

### Removed
- Gemini CLI (deprecated) from the agent list, docs and website.

## [0.8.0] - 2026-10-12

### Added
- **Built-in agent** for OpenRouter (free `:free` models first), local Ollama and any OpenAI-compatible API — no extra CLI needed.
- `~/.tabhelm/env` for API keys, loaded for every agent; `npm run set-key -- openrouter` stores a key without echoing it.

## [0.7.0] - 2026-10-12

### Added
- Update and news banner in the panel, fed by `news.json` on the website.

## [0.6.0] - 2026-10-12

### Added
- **Continue with another agent** when an agent crashes, errors or stops early; the next agent gets the conversation, every browser action and the current page.
- **Export** the chat and action log as Markdown, or the full event log as JSON.

## [0.5.0] - 2026-10-12

### Added
- **New chat** button.
- Switching agents mid-chat hands the conversation to the new agent.
- **Record video** of each task with a visible agent cursor; saved to `~/Videos/TabHelm`.

## [0.4.0] - 2026-10-12

### Added
- Google Antigravity and Qoder CLI agents, Cursor via the `agent` binary, ACP sign-in from the panel.
- One-command installer, GitHub Pages website, release workflow, English and Ukrainian README with diagrams.

## [0.3.0] - 2026-10-12

### Added
- Model and reasoning-effort selection, remembered per agent.

## [0.2.0] - 2026-10-12

### Added
- Full browser toolset (24 tools): coordinates, hover, drag and drop, key combos, uploads, tabs, iframes, console, network and JavaScript.
- Release build (`npm run build`).

## [0.1.0] - 2026-10-12

### Added
- First version: side-panel chat that drives terminal agents over ACP, with browser tools over MCP.

[0.19.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.19.0
[0.18.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.18.0
[0.17.1]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.17.1
[0.17.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.17.0
[0.16.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.16.0
[0.15.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.15.0
[0.14.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.14.0
[0.13.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.13.0
[0.12.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.12.0
[0.11.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.11.0
[0.10.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.10.0
[0.9.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.9.0
[0.8.1]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.8.1
[0.8.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.8.0
[0.7.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.7.0
[0.6.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.6.0
[0.5.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.5.0
[0.4.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.4.0
