// Pure functions over a chat journal (no DOM, no chrome.*): what replaying a
// saved chat shows, its Markdown export, the hand-over context for another
// agent and the stats line. Kept pure so the self-analysis can run them over
// every saved chat and catch a broken entry type before a user does.

export const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
export const fmtCost = (c) => `${c.currency === 'USD' ? '$' : `${c.currency} `}${c.amount < 0.01 ? c.amount.toFixed(4) : c.amount.toFixed(2)}`;
export const fmtTime = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function statsText(s) {
  const parts = [`⏱ ${fmtTime(s.ms || 0)}`];
  if (s.tokens) parts.push(`${fmtTokens(s.tokens.total || 0)} tokens`);
  if (s.cost) parts.push(fmtCost(s.cost));
  if (s.context?.size) parts.push(`context ${fmtTokens(s.context.used || 0)} / ${fmtTokens(s.context.size)}`);
  return parts.join(' · ');
}

// The TabHelm browser tool an agent's tool-call title names: "browser_click",
// "mcp__tabhelm-browser__browser_click" (Claude Code), "mcp.tabhelm-browser.browser_click"
// (Codex). Null for no browser tool, or another MCP server's (Playwright has browser_* too).
export function browserToolOf(title) {
  const t = String(title || '');
  const server = /mcp(?:__|\.)([\w-]+?)(?:__|\.)browser_/.exec(t)?.[1];
  if (server && server.replace(/_/g, '-') !== 'tabhelm-browser') return null;
  return /browser_[a-z]+(?:_[a-z]+)*/.exec(t)?.[0] || null;
}

// What the panel shows for one saved entry when a chat is reopened, or null.
// The panel's renderOp() turns these into DOM.
export function replayOp(e) {
  switch (e?.type) {
    case 'user':
      return { kind: 'user', text: e.text || '', attachments: e.attachments || [] };
    case 'action':
      return { kind: 'action', desc: e.desc || e.tool || 'action', ok: Boolean(e.ok), error: e.error || null };
    case 'agent_tool':
      return { kind: 'tool', title: e.title || 'tool', ok: Boolean(e.ok) };
    case 'agent':
      return { kind: 'agent', agent: e.agent || 'Agent', text: e.text || '', thought: e.thought || '', failure: e.failure || null, stats: e.stats || null };
    case 'permission':
    case 'confirm':
      return { kind: 'notice', text: `🔐 ${e.title || ''} → ${e.answer || ''}` };
    case 'ask':
      return { kind: 'notice', text: e.kind === 'login' ? 'Sign-in requested' : e.message ? `Agent asked: ${e.message}` : `Answered: ${e.answer ?? ''}` };
    case 'notice':
      return e.error ? { kind: 'notice', text: e.text || '', error: true } : null;
    case 'video':
      return { kind: 'notice', text: `🎥 Recording saved: ${e.path || ''}` };
    case 'agent_connected':
      return { kind: 'notice', text: `${e.agent || 'Agent'} connected` };
    case 'agent_switch':
      return { kind: 'notice', text: `Switched to ${e.to || 'another agent'}` };
    case 'folder':
      return { kind: 'notice', text: e.path ? `Working folder: ${e.path}` : 'Working folder removed' };
    case 'diagnose':
      return { kind: 'notice', text: `Diagnosed this chat: ${e.count ?? 0} finding(s)` };
    case 'user_report':
      return { kind: 'notice', text: `You reported: ${e.text || ''}` };
    default:
      return null;
  }
}

export function totalsLine(entries) {
  const turns = entries.filter((e) => e.type === 'agent' && e.stats);
  if (!turns.length) return null;
  const ms = turns.reduce((a, e) => a + (e.stats.ms || 0), 0);
  const tokens = turns.reduce((a, e) => a + (e.stats.tokens?.total || 0), 0);
  const costs = turns.filter((e) => e.stats.cost);
  const cost = costs.reduce((a, e) => a + e.stats.cost.amount, 0);
  return `- Totals: ${turns.length} tasks · ${fmtTime(ms)}${tokens ? ` · ${fmtTokens(tokens)} tokens` : ''}${costs.length ? ` · ${fmtCost({ amount: cost, currency: costs[0].stats.cost.currency })}` : ''}`;
}

// One entry of the Markdown export. `st` carries { out, inActions } across entries.
export function mdEntry(e, st, time = (ts) => new Date(ts).toLocaleTimeString()) {
  const { out } = st;
  const t = time(e.ts);
  const section = (heading) => {
    st.inActions = false;
    out.push('', `### ${heading}`, '');
  };
  switch (e.type) {
    case 'user':
      section(`${t} · You`);
      out.push(e.text || '');
      if (e.attachments?.length) out.push('', ...e.attachments.map((a) => `- 📎 ${a.name} (${a.kind}, ${Math.round((a.size || 0) / 1024)} KB)`));
      break;
    case 'action':
    case 'agent_tool':
      if (!st.inActions) {
        section(`${t} · ${e.agent || 'Agent'} — actions`);
        st.inActions = true;
      }
      if (e.type === 'action') out.push(`- ${t} ${e.ok ? '✓' : '✗'} ${e.desc || e.tool || 'action'}${e.error ? ` — ${e.error}` : ''}`);
      else out.push(`- ${t} ${e.ok ? '✓' : '✗'} (agent tool) ${e.title || ''}`);
      break;
    case 'agent':
      section(`${t} · ${e.agent || 'Agent'}${e.model ? ` (${e.model})` : ''}`);
      if (e.thought) out.push('<details><summary>Thinking</summary>', '', e.thought, '', '</details>', '');
      out.push(e.text || '_No answer._');
      if (e.failure) out.push('', `> ⚠️ Stopped before finishing: ${e.failure}`);
      if (e.stats) out.push('', `_${statsText(e.stats)}_`);
      break;
    case 'permission':
      out.push(`- ${t} 🔐 ${e.title || ''} → ${e.answer || ''}`);
      break;
    case 'confirm':
      out.push(`- ${t} 🔐 ${e.title || ''} → ${e.answer || ''}${e.detail ? ` (${String(e.detail).replace(/\n/g, ', ')})` : ''}`);
      break;
    case 'ask':
      out.push(`- ${t} 🙋 ${e.kind === 'login' ? 'Sign-in requested' : e.message ? `Agent asked: ${e.message}` : `Answered: ${e.answer ?? ''}`}`);
      break;
    case 'video':
      out.push(`- ${t} 🎥 Recording saved: \`${e.path || ''}\``);
      break;
    case 'video_deleted':
      out.push(`- ${t} 🗑 Recording deleted${e.path ? `: \`${e.path}\`` : ''}`);
      break;
    case 'model':
      out.push('', `> ${t} · ${e.agent || 'Agent'}: model ${e.model || ''}`);
      break;
    case 'agent_connected':
      out.push('', `> ${t} · ${e.agent || 'Agent'} connected`);
      st.inActions = false;
      break;
    case 'agent_exit':
      out.push('', `> ⚠️ ${t} · The agent process exited${e.code != null ? ` (code ${e.code})` : e.signal ? ` (${e.signal})` : ''}`);
      st.inActions = false;
      break;
    case 'host_disconnected':
      out.push('', `> ⚠️ ${t} · The TabHelm host disconnected`);
      st.inActions = false;
      break;
    case 'folder':
      out.push('', `> ${t} · Working folder: ${e.path ? `\`${e.path}\`` : 'none'}`);
      st.inActions = false;
      break;
    case 'pause':
      out.push('', `> ${t} · Paused — user took over`);
      break;
    case 'resume':
      out.push('', `> ${t} · Resumed`);
      break;
    case 'plan_offer':
      out.push('', `> ${t} · Plan shown, waiting for Start`);
      break;
    case 'agent_switch':
      out.push('', `> ${t} · Switched to ${e.to || 'another agent'}${e.reason ? ` (previous agent stopped: ${e.reason})` : ''}`);
      st.inActions = false;
      break;
    case 'diagnose':
      out.push('', `> ${t} · Self-analysis of this chat: ${e.count ?? 0} finding(s)${e.rules?.length ? ` (${e.rules.join(', ')})` : ''}`);
      break;
    case 'user_report':
      out.push('', `> ${t} · You reported: ${e.text || ''}`);
      break;
    case 'notice':
      if (e.error) out.push('', `> ⚠️ ${t} · ${e.text || ''}`);
      break;
  }
}

export function exportMarkdown(tab, entries, { now = new Date(), time } = {}) {
  const agents = [...new Set(entries.filter((e) => e.type === 'agent_connected').map((e) => e.agent))];
  const out = [
    '# TabHelm chat',
    '',
    `- Exported: ${now.toLocaleString()}`,
    tab ? `- Tab: ${tab.title} — ${tab.url}` : null,
    agents.length ? `- Agents: ${agents.join(' → ')}` : null,
    totalsLine(entries),
    '',
  ].filter((l) => l !== null);
  const st = { out, inActions: false };
  for (const e of entries) mdEntry(e, st, time);
  return `${out.join('\n')}\n`;
}

// The conversation for the next agent (hand-over): messages, browser actions,
// unfinished work. Keeps the most recent ~12k characters; null when empty.
// `pendingTurn` is the turn of a message already in the journal that goes to
// the agent as the prompt itself: it is left out so the agent does not get it twice.
export function contextText(entries, currentAgent = null, { pendingTurn = null } = {}) {
  const blocks = [];
  let actions = [];
  const flush = (agent) => {
    if (actions.length) blocks.push(`[${agent || 'Agent'} did in the browser] ${actions.join('; ')}`);
    actions = [];
  };
  for (const e of entries) {
    if (e.type === 'user' && pendingTurn != null && e.turn === pendingTurn) continue;
    if (e.type === 'user') blocks.push(`User: ${e.text || ''}${e.attachments?.length ? ` (attached: ${e.attachments.map((a) => a.name).join(', ')})` : ''}`);
    else if (e.type === 'action') actions.push(`${e.ok ? '' : 'FAILED '}${e.desc || e.tool || 'action'}${e.error ? ` (${e.error})` : ''}`);
    else if (e.type === 'agent') {
      flush(e.agent);
      if (e.text) blocks.push(`${e.agent || 'Agent'}: ${e.text}`);
      if (e.failure) blocks.push(`(${e.agent || 'Agent'} stopped before finishing: ${e.failure})`);
    }
  }
  flush(currentAgent);
  if (!blocks.length) return null;
  let out = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (out.length + blocks[i].length > 12_000) break;
    out = `${blocks[i]}\n\n${out}`;
  }
  return out;
}
