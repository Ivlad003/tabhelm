# Changelog

All notable changes to TabHelm. The newest release is at the top; the panel's update banner links here.

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
