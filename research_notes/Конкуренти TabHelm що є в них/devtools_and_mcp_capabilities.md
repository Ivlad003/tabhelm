# Developer-facing browser-automation tools and MCP servers vs TabHelm (as of October 2026)

Scope: Claude Code `--chrome`, Codex, Cursor, Cline, Kilo Code, OpenCode, Antigravity, Gemini CLI, Qoder, GitHub Copilot (bonus reference), plus Playwright MCP, chrome-devtools-mcp, Browser MCP, Puppeteer MCP, Browserbase MCP, and WebMCP. All tool names/flags are quoted from the primary docs fetched on 2026-10-12 unless marked "unverified".

TabHelm baseline (not listed as gaps unless done notably better): browser_snapshot (refs, iframes), find, get_text, screenshot (viewport/full/element), click (buttons/double/modifiers), click_xy, hover, drag, type, select_option, press_key, upload_file, scroll, navigate, back/forward/reload, tabs (list/new/switch/close, tab-group sharing), search_tabs, wait (seconds/text), handle_dialog, console, network (list), evaluate (user-confirmed), skill_*.

---

## Key Question 1: Which concrete capabilities do these tools expose that TabHelm's 25 tools do not?

### Takeaway
The biggest, best-documented gaps are all in Playwright MCP and chrome-devtools-mcp: network request/response bodies and request mocking, cookie/storage/auth-state access, device/network/CPU/geolocation emulation, performance tracing + Lighthouse, PDF export, batch `fill_form`, `verify_*` assertions + `generate_locator` + codegen, action/video recording with annotations and highlights, heap-snapshot memory analysis, extension/PWA management, and WebMCP tool discovery/execution. Agent CLIs (Claude Code, Codex, Cursor) add UX features rather than new primitives: GIF recording, "save screenshot to disk", DevTools-protocol "developer mode", and site-level permission allowlists.

### Cited Findings

**Playwright MCP (microsoft/playwright-mcp) — core tools TabHelm lacks or that differ**
- `browser_fill_form` with a `fields` array fills many fields in one call — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_drop` (element/target, `paths`, `data`) drops files/data onto an element, distinct from `browser_file_upload` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_emulate_media` (colorScheme, reducedMotion, forcedColors, contrast, media) — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_resize` (width, height) for viewport resizing — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_snapshot` accepts `depth` (limit tree depth) and `boxes`; server flag `--snapshot-boxes` emits `[box=x,y,width,height]` viewport-relative CSS-pixel boxes; `--snapshot-mode full|none` (`none` disables snapshots in responses) — [Playwright MCP README](https://github.com/microsoft/playwright-mcp); [raw README](https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md)
- `browser_take_screenshot` has `type`, `filename`, `fullPage`, `scale`, `element` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_type` has `submit` and `slowly` options; `browser_wait_for` supports `textGone` (wait for text to disappear) in addition to `time`/`text` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_console_messages` filters by `level` and can write to `filename`; `browser_find` supports `regex` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `browser_run_code_unsafe` (code, filename) runs arbitrary Playwright code — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)

**Playwright MCP opt-in capabilities via `--caps`** (`vision, pdf, devtools, network, storage, config, testing`) — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `--caps=network`: `browser_network_requests` (static, filter, filename), `browser_network_request` (index, `part`, filename) to read a request/response part, `browser_network_state_set` (state: "offline"/"online"), `browser_route` (pattern, status, body, contentType, headers, removeHeaders) to mock responses, `browser_route_list`, `browser_unroute` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `--caps=storage`: `browser_cookie_{clear,delete,get,list,set}`, `browser_localstorage_{clear,delete,get,list,set}`, `browser_sessionstorage_{clear,delete,get,list,set}`, plus `browser_storage_state` / `browser_set_storage_state` for auth-state save/restore — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `--caps=devtools`: `browser_annotate` (opens Dashboard annotation mode; returns screenshot, ARIA snapshot and annotation list), `browser_highlight` / `browser_hide_highlight` (persistent overlay), `browser_resume`, `browser_start_recording` / `browser_stop_recording` (captures user actions as Playwright code), `browser_start_tracing` / `browser_stop_tracing`, `browser_start_video` (filename, size, fps default 25, cursor animation) / `browser_stop_video`, `browser_video_chapter`, `browser_video_show_actions` / `browser_video_hide_actions` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp); [raw README](https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md)
- `--caps=vision`: coordinate tools `browser_mouse_click_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_wheel` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `--caps=pdf`: `browser_pdf_save` exports the page as PDF — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- `--caps=testing`: `browser_generate_locator`, `browser_verify_element_visible` (by ROLE and ACCESSIBLE_NAME), `browser_verify_list_visible`, `browser_verify_text_visible`, `browser_verify_value` (checkboxes use "true"/"false") — [raw README](https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md)
- `--caps=config`: `browser_get_config` — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)

**Playwright MCP server flags relevant to TabHelm gaps**
- `--device` (e.g. "iPhone 15"), `--mobile` (generic Pixel 10/iPhone 17 emulation), `--viewport-size`, `--user-agent`, `--grant-permissions` (geolocation, clipboard-read, clipboard-write, ...), `--storage-state`, `--isolated`, `--user-data-dir`, `--init-script`, `--init-page`, `--secrets` (dotenv file; masks sensitive data in responses), `--codegen typescript|python|java|csharp|none`, `--save-session`, `--output-dir`, `--output-max-size`, `--image-responses allow|omit|only`, `--allowed-origins`/`--blocked-origins`, `--allowed-hosts`, `--block-service-workers`, `--ignore-https-errors`, `--proxy-server`, `--timeout-action` (default 5000 ms), `--timeout-navigation` (60000), `--timeout-settle` (500), `--test-id-attribute`, `--headless`, `--shared-browser-context`, `--no-webmcp` (don't expose WebMCP tools; config key `webmcp`) — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- Profile modes: persistent (default, `~/Library/Caches/ms-playwright/mcp-{channel}-{workspace-hash}` on macOS), `--isolated` (in-memory; seed with `--storage-state`), `--extension` (connect to running browser via Playwright Extension; `--profile-dir-name` picks Chrome profile) — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)

**chrome-devtools-mcp (ChromeDevTools/chrome-devtools-mcp) — tools TabHelm lacks** — [Tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
- Input: `fill` (uid, value), `fill_form` (elements), `click_at` (x, y, dblClick), `type_text` (text, submitKey); most input tools take `includeSnapshot` to return a fresh snapshot in the same call
- Navigation: `new_page` (url, `background`, `isolatedContext`, timeout), `navigate_page` (handleBeforeUnload, ignoreCache, `initScript`, timeout, `type`), `select_page` (bringToFront), `list_pages`, `close_page`, `wait_for` (text, timeout)
- Emulation: `emulate` (colorScheme, `cpuThrottlingRate`, `extraHttpHeaders`, forcedColors, `geolocation`, `networkConditions`, prefersContrast, prefersReducedMotion, `userAgent`, `viewport`), `resize_page`
- Performance: `performance_start_trace` (autoStop, filePath, `reload`), `performance_stop_trace` (filePath), `performance_analyze_insight` (insightName, insightSetId)
- Network: `list_network_requests` (includePreservedRequests, pageIdx, pageSize, `resourceTypes`), `get_network_request` (reqid, `requestFilePath`, `responseFilePath`) — bodies saved to files
- Debugging: `evaluate_script` (args, dialogAction, filePath, `format`, function, `sourcePath`, `waitForStableDom`), `get_console_message` (msgid), `list_console_messages` (includePreservedMessages, `includeStackTraces`, pageIdx, pageSize, `serviceWorkerId`, `types`), `get_css_styles` (uid), `lighthouse_audit` (device, mode, outputDirPath), `take_screenshot` (filePath, format, fullPage, `quality`, uid), `take_snapshot` (filePath, `verbose`), `screencast_start` / `screencast_stop`
- Memory (14 tools): `take_heapsnapshot`, `compare_heapsnapshots`, `get_heapsnapshot_summary`, `get_heapsnapshot_retainers`, `get_heapsnapshot_retaining_paths`, `get_heapsnapshot_dominators`, `get_heapsnapshot_duplicate_strings`, `query_heapsnapshot_objects`, etc.
- Extensions: `install_extension`, `list_extensions`, `reload_extension`, `trigger_extension_action`, `uninstall_extension`
- Third-party: `list_3p_developer_tools`, `execute_3p_developer_tool`
- WebMCP: `list_webmcp_tools`, `execute_webmcp_tool` (pageId, toolName, input)
- PWA: `get_os_app_state`, `install_pwa`, `launch_pwa`, `uninstall_pwa`
- README-level claims: console messages come "with source-mapped stack traces"; `--slim` exposes "a slim set of 3 tools covering navigation, script execution and screenshots only"; `--no-performance-crux` disables CrUX field data — [chrome-devtools-mcp README](https://github.com/ChromeDevTools/chrome-devtools-mcp); [configuration.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)
- Config flags: `--browserUrl`, `--wsEndpoint`, `--wsHeaders`, `--autoConnect` ("automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param"), `--headless`, `--executablePath`, `--isolated`, `--channel canary|dev|beta|stable`, `--viewport`, `--proxyServer`, `--acceptInsecureCerts`, `--chromeArg`, `--categoryEmulation/Performance/Network`, `--experimentalWebmcp` ("Requires Chrome 150+ with the following flag: `--enable-features=WebMCP`"), `--performanceCrux`, `--logFile`, `--config` — [configuration.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)

**Claude Code / Claude in Chrome (claude-in-chrome MCP) — extras**
- GIF session recording ("record browser interactions as GIFs"), screenshot `save_to_disk` option (fixed in v2.1.211), file uploads up to 10 MB total with refusal of credential-named files (`.env`, `.pem`, `.key`, `.ssh`; v2.1.293+), `browser_batch` for chaining actions, `tabs_context_mcp` with `createIfEmpty`, shortcuts (`shortcuts_list`/`shortcuts_execute`), scheduled tasks saved in the extension — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)
- Tool names visible in the deferred tool list of this session: `browser_batch, computer, file_upload, find, form_input, get_page_text, gif_creator, javascript_tool, list_connected_browsers, navigate, read_console_messages, read_network_requests, read_page, resize_window, select_browser, shortcuts_execute, shortcuts_list, switch_browser, tabs_close_mcp, tabs_context_mcp, tabs_create_mcp, upload_image` — observed in this session's tool roster (not a published doc; the docs say to run `/mcp` > `claude-in-chrome` > "View tools" for the list) — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)
- Multi-browser: `list_connected_browsers` / `select_browser` / `switch_browser`; `/chrome` > "Select browser…" when more than one browser is connected — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)

**Codex (ChatGPT desktop app) — extras**
- Browser is "exclusive to the ChatGPT desktop app" (not CLI/IDE); built-in browser supports "Downloads to system folders", search history and tab management, and a "Developer Mode" with "controlled access to the Chrome DevTools Protocol (CDP)" for performance profiling, console inspection, network traffic analysis and DOM examination, requiring explicit user approval; "Full CDP access" can be disabled by admins — [learn.chatgpt.com/codex/browser](https://learn.chatgpt.com/codex/browser)
- Codex "Site tools (WebMCP)": discovers tools registered via `document.modelContext.registerTool()`; address-bar "Site tools" > "Available site tools"; each invocation undergoes safety review; does not support declarative HTML form attributes or tools in iframes; requires GPT-5.6 Sol / GPT-6 Sol — [learn.chatgpt.com/codex/webmcp](https://learn.chatgpt.com/codex/webmcp)

**Browserbase MCP** — 6 tools: `start`, `end`, `navigate`, `act` ({action: string}), `observe` ({instruction}), `extract` ({instruction?}) (Stagehand natural-language actions on a cloud browser) — [search summary of mcp-server-browserbase README](https://cdn.jsdelivr.net/gh/browserbase/mcp-server-browserbase@main/README.md)

**Browser MCP (browsermcp.io)** — tools: Navigate, Go Back, Go Forward, Wait, Press Key, Snapshot, Click, Drag & Drop, Hover, Type Text, Get Console Logs, Screenshot — nothing beyond TabHelm — [browsermcp.io](https://browsermcp.io/)

**GitHub Copilot in VS Code (reference)** — browser tools GA 2026-07-01: navigate, click, type, hover, drag, handle dialogs, read page content, console errors, screenshots; "DevTools integrated in browser toolbar"; "Scripted flow execution for multi-step sequences"; per-site approval for camera/microphone/location/clipboard reads — [github.blog changelog](https://github.blog/changelog/2026-07-01-browser-tools-for-github-copilot-in-vs-code-are-generally-available)

### Inferences
- Prioritized gap list for TabHelm (each exists in at least one shipping tool): (1) `network_request` body read + `route`/mock + offline toggle; (2) cookies/localStorage/sessionStorage get/set + `storage_state` export/import; (3) `emulate` (viewport/device, network throttling, CPU throttle, geolocation, color scheme, UA, extra headers); (4) `fill_form` batch; (5) `verify_*` assertions + `generate_locator` + action recording to Playwright code (`--codegen`); (6) `performance_start_trace`/`lighthouse_audit`; (7) `pdf_save`; (8) `highlight`/`annotate` overlays and video/GIF recording with action chapters; (9) `wait_for` with `textGone`; (10) `includeSnapshot` on action tools (one round-trip); (11) `list_webmcp_tools`/`execute_webmcp_tool`; (12) heap-snapshot memory tools (niche); (13) background/isolated `new_page` and downloads handling (Codex "Downloads to system folders").
- `--secrets` (masking sensitive values in responses) and `--image-responses omit` are cheap, high-value safety/token features TabHelm can copy.

### Gaps
- Puppeteer MCP: no primary source fetched this session; the reference `@modelcontextprotocol/server-puppeteer` is archived upstream per my prior knowledge (unverified here).
- Playwright MCP's `browser_tabs` details (action/index/url) match TabHelm; whether Playwright MCP has tab-group sharing: no.
- OpenCode: the docs index lists no built-in browser tool; only MCP servers/custom tools — [opencode.ai/docs](https://opencode.ai/docs/). Could not confirm an OpenCode-specific browser tool.

---

## Key Question 2: How does each agent CLI integrate browsing in its own UI, and what UX does it offer?

### Takeaway
Three patterns: (a) real-Chrome extension bridge with per-site permission prompts (Claude Code, Codex extension, Qoder "Connect My Chrome", Cline remote debugging, Gemini CLI `existing` mode); (b) embedded isolated browser pane beside the chat (Cursor, Codex built-in, Qoder, Copilot); (c) separate-profile subagent that returns screenshots/videos as artifacts (Antigravity). Only Playwright MCP documents an explicit element `highlight`/`annotate` overlay.

### Cited Findings
- Claude Code: `claude --chrome` or `/chrome` ("Enabled by default"); "Browser actions run in a visible Chrome window in real time"; tabs collected "into a Chrome tab group tied to your session" and closed on `/clear` (rules for `/resume`/exit); permission dialog "starts with `Claude in Chrome wants to` and offers an option to allow all actions on that site for the session"; "Site-level permissions are inherited from the Chrome extension"; in auto mode the classifier's approval skips the extension's per-site check; pauses on login/CAPTCHA; VS Code shows prompts as a card and `@browser`; a project's `.claude/settings.json` cannot set `CLAUDE_CODE_ENABLE_CFC`; "Enabling Chrome by default increases context usage since the browser tools and their instructions are always loaded"; Edge/Brave/Arc/Vivaldi/Opera supported, WSL not; extension v1.0.36+ and a direct Anthropic plan required — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)
- Cursor: browser "displays as an inline pane within Cursor alongside Agent's chat"; "Agent shows browser actions and screenshots directly in conversations"; tools: Navigate, Click (click/double/right/hover), Type, Scroll, Screenshot, Console Output, Network Traffic ("currently Agent panel only"); approval modes under Cursor Settings > Agents > Auto-Run: Manual approval, Allow-listed actions, Auto-run; enterprise "Origin Allowlist"; implemented as "an MCP server extension"; recommends "Sonnet 4.5, GPT-5, and Auto" — [cursor.com/docs/agent/browser](https://cursor.com/docs/agent/browser)
- Codex: built-in browser in ChatGPT desktop app; per-website permission settings (browsing, downloads, uploads); "Confirmation required before sensitive actions (form submission, purchases, data deletion)"; Chrome extension adds Side Chat, `@`-mention of open tabs, highlight-text-to-chat — [learn.chatgpt.com/codex/browser](https://learn.chatgpt.com/codex/browser); [learn.chatgpt.com/codex/chrome-extension](https://learn.chatgpt.com/codex/chrome-extension)
- Antigravity: "specialized Browser Subagent" that can "open, read, and actuate a local Chrome browser"; captures "screenshots and saving action videos as interactive artifacts"; URL "allowlist and denylist"; "Browser Tools" toggle in user settings — [antigravity.google/docs/ide/browser](https://antigravity.google/docs/ide/browser)
- Qoder: "a web work surface beside the task conversation"; navigation, multi-tab, content inspection, interaction, "Annotate pages, copy screenshots, and copy links"; limitations around complex canvases, pop-ups, security challenges — [docs.qoder.com/qoder/browser](https://docs.qoder.com/qoder/browser). "Connect My Chrome" (reuse tabs, login state, extensions like React DevTools/uBlock) comes from third-party Chinese tech press, not the fetched Qoder doc page — [juejin.cn](https://juejin.cn/post/7653331314107809846); [developer.aliyun.com](https://developer.aliyun.com/article/1752414) (secondary; treat as partially verified)
- Kilo Code: Settings > Web Tools > Browser Automation: "Enable browser automation", "Headless mode" (default disabled), "Use system Chrome" ("Enabled by default — uses your installed Chrome"); screenshots after each action; "Browser Use requires an advanced agentic model" — [kilo.ai/docs/features/browser-use](https://kilo.ai/docs/features/browser-use)
- Gemini CLI: v0.31.0 (2026-02-27) added "an experimental browser agent"; requires Chrome 144+, "disabled by default — enable via agents.overrides"; settings `agents.browser.confirmSensitiveActions` ("Require manual confirmation for sensitive browser actions (e.g., fill_form, evaluate_script)", default false) and `agents.browser.blockFileUploads` (default false) — [geminicli.com/docs/cli/settings](https://geminicli.com/docs/cli/settings/); [mintlify changelog mirror](https://www.mintlify.com/google-gemini/gemini-cli/resources/changelog) (secondary)
- Copilot VS Code: "The agent can't read or interact with a page you opened until you select **Share with Agent**"; screenshots fed into chat; DevTools in the browser toolbar; admin domain allow/deny with wildcards — [github.blog](https://github.blog/changelog/2026-07-01-browser-tools-for-github-copilot-in-vs-code-are-generally-available)
- Element highlighting: Playwright MCP `browser_highlight` ("persistent overlay") and `browser_annotate`; `browser_video_show_actions` overlays actions in recordings — [raw README](https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md). No other fetched doc describes highlighting the element being acted on.

### Inferences
- Gemini CLI's browser agent tool names (`fill_form`, `evaluate_script`) match chrome-devtools-mcp, suggesting it wraps that server (inference, unverified).
- The industry consensus UX set is: screenshot-in-chat, per-site allow prompt with "allow all on this site for session", enterprise origin allowlist, pause on login/CAPTCHA, tab grouping. TabHelm already has tab-group sharing; the missing UX pieces are an on-page highlight overlay, GIF/video recording, and a downloads permission.

### Gaps
- Cursor's docs do not say whether the in-pane browser highlights the acted-on element.
- Antigravity's doc page did not expose tool names or approval granularity.
- Cline: current tool reference lists `read_files, search_codebase, run_commands, fetch_web_content, apply_patch, editor, skills, ask_question, submit_and_exit` and no `browser_action` — [docs.cline.bot/tools-reference/browser-automation](https://docs.cline.bot/tools-reference/browser-automation) (page returned the generic tools page). Whether `browser_action` (launch/click/type/scroll_down/scroll_up/close) still ships in Cline as of Oct 2026 is unverified; the Cline 3.10 blog documents "Local Chrome Integration" via remote debugging — [cline.bot blog](https://cline.bot/blog/cline-3-10-local-chrome-integration-yolo-mode-drag-drop-and-more-workflow-enhancements) (not fetched; search snippet only).

---

## Key Question 3: Which tools share cookies/sessions from the user's real Chrome vs isolated profiles?

### Takeaway
Real-Chrome session sharing: Claude Code (extension), Codex Chrome extension, Browser MCP, Playwright MCP `--extension`, chrome-devtools-mcp `--browserUrl`/`--autoConnect`, Cline remote debugging, Kilo "Use system Chrome", Gemini CLI `existing` mode, Qoder "Connect My Chrome". Isolated by design: Cursor, Antigravity, Codex built-in browser, Copilot, Browserbase, Playwright MCP default/`--isolated`.

### Cited Findings
- Claude Code "shares your browser's login state, so it can access any site you're already signed into" — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)
- Cursor browser "does **not** share the user's Chrome cookies or profile"; per-workspace persisted cookies/localStorage/sessionStorage/IndexedDB; random auth token per session and per-tab IDs — [cursor.com/docs/agent/browser](https://cursor.com/docs/agent/browser)
- Antigravity agent "executes inside a completely separate Chrome profile to protect your personal data" — [antigravity.google/docs/ide/browser](https://antigravity.google/docs/ide/browser)
- Codex: built-in browser is "An isolated profile separate from the user's regular browser"; optional Chrome extension uses "the user's actual browser profile" to "read or act on sites where you're already signed in" — [learn.chatgpt.com/codex/browser](https://learn.chatgpt.com/codex/browser); [chrome-extension](https://learn.chatgpt.com/codex/chrome-extension)
- Browser MCP "uses your existing browser profile, keeping you logged into all your services" and "avoids basic bot detection and CAPTCHAs by using your real browser fingerprint" — [browsermcp.io](https://browsermcp.io/)
- Playwright MCP `--extension`: "Connect to a running browser instance (Edge/Chrome only). Requires the 'Playwright Extension' to be installed"; `--profile-dir-name` selects profile; default persistent profile is Playwright-owned, `--isolated` is in-memory — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- chrome-devtools-mcp `--autoConnect` attaches to the user's local Chrome 144+ user-data-dir by channel; `--browserUrl` to `http://127.0.0.1:9222`; `--isolated` temp dir — [configuration.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)
- Gemini CLI session modes: `default` (cookies/history preserved), `isolated` (temporary profile deleted after session), `existing` (attach to running Chrome via `chrome://inspect/#remote-debugging`) — [mintlify changelog mirror / search summary](https://www.mintlify.com/google-gemini/gemini-cli/resources/changelog) (secondary; primary docs page 404 at the URLs tried)
- Cline remote debugging: user ticks "Allow remote debugging for this browser instance" at `chrome://inspect/#remote-debugging`, letting Cline "operate directly within your real browser environment" and "leverage your existing authenticated sessions" — [docs.cline.bot remote-browser-support](https://docs.cline.bot/exploring-clines-tools/remote-browser-support) (search snippet; direct fetch returned generic page)
- Kilo Code "Use system Chrome: Enabled by default — uses your installed Chrome" — [kilo.ai/docs/features/browser-use](https://kilo.ai/docs/features/browser-use) (whether that means the user's logged-in profile or a separate profile of the same binary is not stated)
- Copilot: "Agent tabs remain isolated from user browsing data and cookies" — [github.blog](https://github.blog/changelog/2026-07-01-browser-tools-for-github-copilot-in-vs-code-are-generally-available)

### Inferences
- TabHelm's real-Chrome model matches Claude Code/Codex-extension/Browser MCP. The isolated-profile camp compensates with `storage_state`-style persistence; TabHelm could offer both by adding an "isolated context" mode (chrome-devtools-mcp `new_page isolatedContext`) plus cookie/storage tools.

### Gaps
- Kilo's "Use system Chrome" semantics regarding cookies are undocumented in the fetched page.

---

## Key Question 4: Benchmarks / docs on reliability (incremental snapshots, token sizes)

### Takeaway
No fetched primary source publishes token-size or reliability benchmarks. The documented levers are snapshot `depth`, `--snapshot-mode none`, `includeSnapshot` per action, `--image-responses omit`, `--slim`, and paginated console/network listings.

### Cited Findings
- Playwright MCP: `browser_snapshot` `depth` limits traversal; `--snapshot-mode none` disables snapshots in responses; `--image-responses omit`; tool uses "Playwright's accessibility tree, not pixel-based input" and "operates purely on structured data" — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- chrome-devtools-mcp: `take_snapshot` `verbose` flag; `includeSnapshot` on input tools; `list_console_messages`/`list_network_requests` paginated via `pageIdx`/`pageSize`; `--slim` 3-tool mode — [tool-reference.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md); [README](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- Claude Code warns enabling Chrome by default "increases context usage since the browser tools and their instructions are always loaded" — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)
- Claude Code known failure modes: extension service worker idles ("Receiving end does not exist"), JS dialogs block commands, organization IP allowlist must permit `bridge.claudeusercontent.com` — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome)

### Inferences
- "Incremental/diff snapshots" in Playwright MCP: not found in the README fetched; treat as unverified/absent.

### Gaps
- No token-size benchmarks found for any server; no third-party reliability comparison fetched.

---

## Key Question 5: WebMCP (document.modelContext) adoption in Chrome and sites exposing tools

### Takeaway
WebMCP is in a Chrome origin trial (149–156) with the API renamed from `navigator.modelContext` to `document.modelContext` in Chrome 150; consumers that ship today are chrome-devtools-mcp (`list_webmcp_tools`/`execute_webmcp_tool`, Chrome 150+ with `--enable-features=WebMCP`), Playwright MCP (on by default, `--no-webmcp`), Stagehand (`page.listWebMCPTools()`/`invokeWebMCPTool`), and Codex Site tools; real-site adoption is near zero apart from OpenAI's own docs and Google demos.

### Cited Findings
- Chrome shipped a developer trial 2026-05-18 and announced the public origin trial in Chrome 149 at I/O; API `navigator.modelContext.registerTool`; Chrome 150 deprecates `navigator.modelContext` in favor of `document.modelContext` (spec moved getter to Document in the 2026-05-27 draft); trial runs through Chrome 156 — [dev.to summary](https://dev.to/thousand_miles_ai/webmcp-in-chrome-149-web-pages-get-a-tool-api-for-ai-agents-bfi); [OpenHermit](https://www.openhermit.com/blog/webmcp-chrome-149-origin-trial-production-2026) (secondary sources; official Chrome blog page only says "early preview" and points to the EPP) — [developer.chrome.com/blog/webmcp-epp](https://developer.chrome.com/blog/webmcp-epp)
- State July 2026: Edge experimental behind a flag; declarative form variant "coming" with spec section TODO; "No mainstream agents consume WebMCP yet"; pilot participants named at I/O (Expedia, Booking.com, Shopify) with no confirmed deployments; "registered tools round to zero outside demos and the checker sites themselves" — [Spronta](https://www.spronta.com/blog/state-of-webmcp-july-2026/) (opinionated secondary source; contradicted on "no agents consume it" by Codex docs and chrome-devtools-mcp docs below)
- chrome-devtools-mcp `--experimentalWebmcp` "Requires Chrome 150+ with the following flag: `--enable-features=WebMCP`"; tools `list_webmcp_tools`, `execute_webmcp_tool` — [configuration.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md); [tool-reference.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
- Playwright MCP has `--no-webmcp` ("Don't expose WebMCP tools"), i.e. WebMCP tools exposed by default — [Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- Stagehand: `page.listWebMCPTools()` (name, description, inputSchema, annotations, frameId) and `page.invokeWebMCPTool(name, input, options)` returning Completed/Canceled/Error; requires Chrome 149+ with `--enable-features=WebMCPTesting,DevToolsWebMCPSupport`; demo site `https://googlechromelabs.github.io/webmcp-tools/demos/react-flightsearch/` — [docs.stagehand.dev/v3/basics/webmcp](https://docs.stagehand.dev/v3/basics/webmcp)
- Codex Site tools: `document.modelContext.registerTool()`; OpenAI docs sites expose `search_openai_docs`, `lookup_page`, `lookup_context`, `navigate_to_page`, `generate_custom_guide`; no declarative forms, no iframe tools — [learn.chatgpt.com/codex/webmcp](https://learn.chatgpt.com/codex/webmcp)

### Inferences
- For TabHelm: a `list_webmcp_tools`/`call_webmcp_tool` pair behind a flag is cheap (read `document.modelContext` from the content script) and future-proofs against Gemini-in-Chrome; expect few real sites until late 2026.

### Gaps
- The task mentioned "Chrome 146–155"; sources say origin trial 149–156 and flag-gated earlier. Exact Chrome 146–148 status not verified.
- No registry of production WebMCP sites was found beyond OpenAI docs and Google Chrome Labs demos.
