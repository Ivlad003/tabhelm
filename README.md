# TabHelm

Чат у бічній панелі Chrome, що керує терміналним агентом (Claude Code, Codex, Cursor Agent, OpenCode, Gemini CLI, Grok), а агент своєю чергою керує **тією вкладкою, де відкрито чат**: читає сторінку, клікає, вводить текст. Працює у вашому звичайному браузері з вашими логінами, без headless-браузера.

```
Вкладка ◄── chrome.debugger / scripting ── Extension (side panel + service worker)
                                                │ Native Messaging
                                                ▼
                                     host/ (Node): native-host.js
                                       ├─ ACP-клієнт ──► claude-agent-acp | codex-acp | cursor-agent acp | opencode acp | gemini --acp | grok agent stdio
                                       └─ tool server (127.0.0.1 + token) ◄── mcp-bridge.js (stdio MCP, запускається агентом)
```

- **ACP** (Agent Client Protocol) дає один протокол для всіх агентів: стрімінг відповіді, виклики інструментів і запити дозволу.
- Браузерні інструменти передаються агенту як MCP-сервер у `session/new`, тож налаштовувати кожен агент вручну не треба.
- Кожна вкладка має окрему панель і окрему сесію агента. Інструменти працюють лише з вкладкою, до якої прив'язаний чат.

## Встановлення

```bash
cd host
npm install
npm run install-host   # реєструє native host для Chrome/Chromium/Brave/Edge
```

1. Відкрийте `chrome://extensions` і ввімкніть **Developer mode**.
2. Натисніть **Load unpacked** і виберіть папку `extension/`. Ключ у manifest фіксує ID розширення: `gcedfnedpmpfkbbgkdihdbkhhohkjjnn`.
3. На будь-якій сторінці натисніть іконку TabHelm, виберіть агента, натисніть **Connect** і напишіть завдання.

Агенти використовують свою звичайну авторизацію. Достатньо, щоб `claude`, `codex`, `cursor-agent`, `opencode`, `grok` чи `gemini` були встановлені й залогінені в терміналі. У списку з'являються лише ті, що знайдені в `PATH`.

`install-host` запам'ятовує поточний `PATH`, бо Chrome запускає хост з мінімальним оточенням. Якщо встановите нового агента, запустіть `install-host` ще раз.

## Інструменти агента

`browser_snapshot`, `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_scroll`, `browser_navigate`, `browser_go_back`, `browser_screenshot`, `browser_get_text`, `browser_wait`, `browser_handle_dialog`

Сторінка подається моделі як компактний текстовий конспект, де інтерактивні елементи мають `ref` (`[e12] button "Save"`). Кліки й введення йдуть через CDP `Input.*`, тож сторінка отримує справжні (`isTrusted`) події.

## Перевірка

```bash
cd host
npm run smoke -- claude     # хост + агент без Chrome (фейкова сторінка); також codex|cursor|opencode|grok|gemini
npm run e2e -- claude       # повний тест у headless Chrome: панель → агент → заповнення форми
```

## Відомі обмеження (MVP)

- Поки агент працює з вкладкою, Chrome показує смугу «TabHelm налагоджує цей браузер». Прибрати її можна лише прапорцем `--silent-debugger-extension-api`.
- Вміст iframe поки не читається (позначається як `[iframe …]`). Closed shadow DOM і canvas доступні лише через скриншот.
- Якщо закрити панель, сесія агента зупиняється, а історія чату не зберігається.
- Сторінки `chrome://` і Chrome Web Store недоступні для розширень.
- Відкритий DevTools на тій самій вкладці блокує `chrome.debugger`.

Логи хоста: `~/.tabhelm/host.log`. Робоча папка агентів: `~/.tabhelm/workspace`.

Дослідження готових рішень, ACP, Ollama та підводних каменів: [docs/research.md](docs/research.md).
