# Changelog

All notable changes to TabHelm. The newest release is at the top; the panel's update banner links here.

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

[0.11.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.11.0
[0.10.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.10.0
[0.9.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.9.0
[0.8.1]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.8.1
[0.8.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.8.0
[0.7.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.7.0
[0.6.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.6.0
[0.5.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.5.0
[0.4.0]: https://github.com/Ivlad003/tabhelm/releases/tag/v0.4.0
