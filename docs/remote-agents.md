# Research: running the CLI agent on another machine

*2026-10-13. Research only — nothing here is implemented.*

Question: can the chat in the local Chrome drive a coding agent (Claude Code, Codex, OpenCode, Cursor…) that runs on another machine — a workstation, a server, a dev container — **without installing extra software**?

## What must stay local and what can move

| Piece | Must be local? | Why |
|---|---|---|
| Chrome extension (panel, page tools, CDP) | yes | it *is* the browser; tool execution happens on the user's tab |
| Native host (`native-host.js`) | the **process Chrome starts** must be local — but it can be a thin pipe | Chrome native messaging only launches a local executable over stdio |
| ACP agent (`claude-code-acp`, `codex acp`, `opencode acp`, `agent acp`) | no | stdio JSON-RPC: any byte pipe works |
| MCP bridge + loopback tool server (what the agent calls to act on the page) | no, but the agent must be able to reach it | today: `mcp-bridge.js` spawned by the agent connects to `127.0.0.1:<port>` on the machine where the host runs |
| Working folder, skills on disk, memory.json, recordings, transcription | follow the host process | all file system work happens where the host runs |

So there are two transports that need **no new software**: **SSH** (client ships with Windows 10+, macOS and every Linux; server is a built-in optional feature on Windows, "Remote Login" on macOS, `openssh-server` on Linux) and, for containers, **`docker exec -i` / `kubectl exec -i`** (already installed if containers are used at all). Both give an 8-bit-clean stdio pipe, which is all ACP and native messaging need.

## Option A — the whole TabHelm host runs remotely, the local host is `ssh` (recommended)

```
Chrome ──native messaging (stdio)──▶ tabhelm-host.sh ──exec──▶ ssh -o BatchMode=yes user@box 'node ~/.tabhelm/app/host/src/native-host.js'
                                                                        │
                                               remote: agents, mcp-bridge, tool server 127.0.0.1, workspace, skills, memory, recordings dir
```

The 4-byte-length frames pass through ssh untouched, so **nothing in the extension or the host changes**; `install.js` only needs a `--remote user@host` mode that writes a wrapper whose body is the `ssh` line instead of `exec node …`. The remote side needs Node 20+ and the TabHelm host (`install.sh` without registering the native host) — that is TabHelm itself, not third-party software.

Pros: one connection, all tool calls already travel over this pipe, every agent works unchanged (they spawn `mcp-bridge.js` locally on the remote box), the working folder / skills / `AGENTS.md` are the project on the remote machine — exactly what a remote dev box is for.

Cons / details to handle:
- **Authentication must be non-interactive**: the host has no TTY, so a key in `ssh-agent` or an unencrypted key + `-o BatchMode=yes`; the first-time host-key prompt must be done once by hand (`ssh user@box true`).
- **Agent sign-in** (`claude login`, `codex login`, `qodercli login`) is done once on the remote machine over a normal SSH session; the ACP `authenticate` flow that opens a browser would open it remotely — detect `remote` and tell the user to sign in via SSH instead.
- **Recordings** (`save_recording`) would land on the remote disk. Fix: keep saving in the panel (it already has the blob — the panel could download it) or add a `recordingsLocal` path — small change.
- **Folder picker** dialogs (zenity/osascript/PowerShell) cannot show on a headless box → fall back to "type the path" (already exists).
- **Attachments** are written into the remote workspace — fine, since the agent runs there.
- **Latency**: each tool call is one round trip over SSH (tens of ms on a LAN, ~100–200 ms across the internet); the agent's own model calls dominate anyway.
- **Windows as the remote**: `ssh user@winbox node C:\Users\…\native-host.js` works with the built-in OpenSSH Server; the `.cmd` spawning fix (0.19.1) already applies.
- **Reconnects**: if the SSH session drops, Chrome sees the host exit → the panel shows *Host offline*; the chat is saved and the hand-over context restarts the agent on reconnect (existing failover). A `ServerAliveInterval` option in the wrapper keeps NAT boxes alive.
- **Update banner / version check** compares the remote host version with the local extension — unchanged.

## Option B — only the agent runs remotely (`launch.command = ssh …`)

```
local host ──spawn──▶ ssh user@box 'claude-code-acp'   (stdio = ACP)
remote agent ──spawns──▶ mcp-bridge.js ?  ✗ the bridge lives on the local machine
```

Workable but needs more plumbing:
1. The agent spawns the MCP server on **its** machine. Either copy `mcp-bridge.js` there once (`scp`, or send it inline with `node -e "$(cat mcp-bridge.js)"` — ugly), **or** give the agent an HTTP MCP server instead of a stdio one. ACP already allows `mcpServers: [{ type: "http", url, headers }]` and agents advertise `agentCapabilities.mcpCapabilities.http` (Claude Code, Codex and OpenCode do; the SDK types in `host/node_modules/@agentclientprotocol/sdk` have the `http`/`sse` variants). TabHelm's tool server is already a loopback HTTP endpoint with a bearer token — it would have to speak MCP Streamable HTTP rather than the custom `/call` route (a day of work with `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`).
2. The remote agent must reach that HTTP server on the local machine: `ssh -R 127.0.0.1:<port>:127.0.0.1:<port>` reverse-forwards it (no new software; `GatewayPorts` not needed because it binds to loopback on the remote side).
3. Per-agent quirks: Cursor's `agent` does not advertise HTTP MCP today; Kilo/Cline/CodeBuddy are npm packages that must be installed on the remote box anyway.

Pros: working folder, skills and memory stay on the local machine (sometimes desired — e.g. a GPU box only for the model/agent). Cons: two kinds of state in two places, more edge cases, HTTP MCP only for some agents.

## Option C — the agents' own remote modes (no SSH)

| Agent | What exists | Usable by TabHelm? |
|---|---|---|
| Claude Code | *Remote Control* / claude.ai/code cloud sessions: the CLI registers with Anthropic's service and a web/mobile client drives it | no public client protocol; it is not ACP. Not usable without reverse-engineering |
| Codex | `codex app-server` (JSON-RPC over stdio, used by the IDE extension); cloud tasks via the Codex web app | app-server is still stdio → same as Option B; the cloud has no local-browser hook |
| OpenCode | `opencode serve --hostname 0.0.0.0 --port N` exposes an HTTP + SSE API; `opencode attach <url>` is a client | yes, but TabHelm would need an OpenCode-API client instead of ACP (its API is agent-specific, and the HTTP server has no auth by default — must stay behind SSH/VPN anyway) |
| Cursor | Cloud "background agents" API | different product: runs in Cursor's cloud sandboxes, cannot touch the local tab |
| Qoder / Kilo / Cline / CodeBuddy | cloud dashboards | no remote stdio/API suitable for a browser-tool loop |

None of these gives a general "remote CLI over the network" that fits the ACP + browser-tools loop; SSH remains the common denominator.

## Option D — transports that need extra software (listed only to rule them out)

- **Tailscale / ZeroTier / WireGuard** — makes Option A work across NATs without port forwarding, but it is extra software (it is optional sugar on top of SSH, not a replacement).
- **ngrok / Cloudflare Tunnel** — expose the loopback tool server publicly; adds a third party in the loop and software on both ends. Not recommended for a tool that can click in a logged-in browser.
- **mosh**, **Eternal Terminal** — resilient SSH; extra packages.
- A WebSocket listener in the TabHelm host with TLS: Chrome could connect from the extension directly (no native host at all!) — but that means exposing a listening port + certificates and an auth scheme; SSH gives all of that for free.

## Recommendation

1. Implement **Option A** as *Remote host mode*: `install.js --remote user@host[:path]` (writes the ssh wrapper; checks `ssh -o BatchMode=yes user@host node -v` first) and, on the remote, `install.sh --no-register`. Panel changes are cosmetic: show "host: user@box" in Settings → Version and route recordings to a local download when the host reports `remote: true`.
2. Keep **`docker exec -i <container> node …`** as the same mechanism with a different command — covers dev containers with zero extra setup.
3. Consider **Option B's HTTP MCP** later only if someone needs local files with a remote agent; it is the bigger refactor (tool server → MCP Streamable HTTP) and only helps agents that support HTTP MCP.
4. Do not build on the agents' cloud/remote-control modes: they are closed or agent-specific and none can reach the local tab.

### Checks to run before building Option A
- Windows local → Linux remote with the built-in `ssh.exe` from a `.cmd` wrapper (quoting; `BatchMode`; key in `%USERPROFILE%\.ssh`).
- Binary safety of native-messaging frames through `ssh` on Windows (should be fine; stdin/stdout are binary in OpenSSH for Windows).
- Behaviour when the remote host prints to stderr (ssh banners) — the host already ignores stderr, Chrome reads only stdout.
- Latency of `browser_screenshot` results (base64 images of ~200 KB) over a slow link — frames are ≤1 MB today, so no protocol change.
