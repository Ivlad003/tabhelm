# TabHelm design system

Soft emerald, calm surfaces, one accent. Used by the side panel (`extension/`) and the website (`site/`).

`design/tokens.css` is the single source of truth. `npm run design` copies it to `extension/tokens.css` and `site/tokens.css`; `npm run build` fails if a copy is out of date. Components never use raw colours — only the `--th-*` tokens (each app maps them to short local names such as `--accent`).

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--th-bg` | `#f3f8f5` | `#0d1512` | page background |
| `--th-surface` | `#ffffff` | `#141f1b` | panels, cards, inputs |
| `--th-surface-2` | `#ebf3ef` | `#1a2823` | secondary surfaces, tool rows |
| `--th-border` / `-strong` | `#d6e5de` / `#b9d3c7` | `#24352e` / `#31473e` | dividers, hover borders |
| `--th-text` | `#13231c` | `#e2f0e9` | primary text |
| `--th-muted` / `--th-faint` | `#5d7168` / `#8a9c94` | `#93aaa0` / `#6d8379` | secondary text, hints |
| `--th-accent` | `#2a9d76` | `#5cc9a1` | primary buttons, links, focus, progress |
| `--th-accent-strong` | `#1c7d5c` | `#84dcbb` | hover, brand text, counts |
| `--th-accent-soft` / `-softer` | `#e0f2e9` / `#f0f8f4` | `#163329` / `#121f1a` | highlights, steps block, current item |
| `--th-user-bubble` | `#e2f3ea` | `#193a2d` | your messages |
| `--th-ok` · `--th-warn` · `--th-err` | `#2e9b62` · `#b7791f` · `#c2452f` | `#5cc98f` · `#e0a64a` · `#ee7a63` | status |

Text on the accent uses `--th-accent-text` (white in light mode, near-black in dark mode). Contrast of body text on surfaces is above WCAG AA in both themes.

## Shape, depth, type

- Radius: `--th-radius-s` 6 px (buttons, inputs), `-m` 10 px (cards, messages, blocks), `-l` 14 px (site sections).
- Shadow: `--th-shadow` for cards that ask for attention (approvals, site cards); everything else is flat with a 1 px border.
- Focus: `--th-focus` — a 3 px soft emerald ring on every focusable control.
- Type: `--th-font` (Inter if installed, else the system UI font), `--th-font-mono` for code, commands and refs. Panel body 13 px / 1.5, site 16 px / 1.6.

## Components (side panel)

- **Buttons** — `.btn` neutral, `.btn.primary` accent, `.btn.small` in toolbars. Hover tints with `--th-accent-softer`.
- **Messages** — your message: right-aligned bubble in `--th-user-bubble`; agent answer: plain text with Markdown; stats line under it in muted 11 px tabular numbers.
- **Steps block** — `.activity`: one message per run of agent steps (browser actions, tool calls such as tool search, thinking). Header with a pulsing emerald dot while working and a step count; the list scrolls inside 190 px.
- **Cards** — approvals and sign-in: surface + shadow + accent buttons; resolved cards fade to muted.
- **Banners** — update banner on `--th-accent-soft` with an accent border; news on plain surface.
- **Chips** — attachments and skills: 1 px border, small radius, thumbnail or file-type badge.

## Logo

`site/logo.svg` — a ship's helm on an emerald gradient (`#3fb68b` → `#1c7d5c`). Extension icons are rendered from it with `node host/scripts/icons.js`.
