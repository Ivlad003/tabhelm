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

## Інструменти агента (24)

| Група | Інструменти |
|---|---|
| Читання | `browser_snapshot` (конспект з `ref`, разом з iframe), `browser_find` (пошук за текстом), `browser_get_text`, `browser_screenshot` (viewport / `fullPage` / елемент) |
| Миша | `browser_click` (ліва/права/середня кнопка, подвійний клік, модифікатори), `browser_click_xy` (координати зі скриншота), `browser_hover`, `browser_drag` (HTML5 drag-and-drop і звичайне перетягування) |
| Клавіатура й форми | `browser_type`, `browser_select_option`, `browser_press_key` (`Enter`, `F5`, `Control+A`, `Shift+Tab`…), `browser_upload_file`, `browser_scroll` (4 напрямки, сторінка або елемент) |
| Навігація й вкладки | `browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_tabs` (list / new / switch / close) |
| Очікування й діалоги | `browser_wait`, `browser_handle_dialog` |
| Діагностика | `browser_console`, `browser_network`, `browser_evaluate` |

- Сторінка подається моделі як компактний текстовий конспект, де інтерактивні елементи мають `ref`: `[e12] button "Save"`, а всередині iframe — `[f3:e5]`.
- Кліки й введення йдуть через CDP `Input.*`, тож сторінка отримує справжні (`isTrusted`) події, зокрема й усередині cross-origin iframe.
- Завантаження файлу, виконання JS і перемикання на вкладку, яку агент не відкривав сам, **завжди** чекають підтвердження в панелі, навіть з увімкненим Auto-approve.
- Нові вкладки агент відкриває у фоні. Ви продовжуєте бачити вкладку з чатом, а в панелі видно, з якою вкладкою агент працює зараз.

## Збірка релізу

```bash
npm run build
```

Збірка перевіряє синтаксис, прибирає тестовий хук і кладе в `dist/`:

| Файл | Що це |
|---|---|
| `tabhelm-<версія>/` | Готовий до запуску реліз: `extension/`, `host/` з production-залежностями, `install.sh` |
| `tabhelm-extension-<версія>.zip` | Лише розширення (~30 KB) |
| `tabhelm-<версія>.tar.gz` | Реліз без `node_modules` (~60 KB). Після розпакування `./install.sh` сам поставить залежності й зареєструє хост |

`node_modules` хоста займає приблизно 750 MB, бо ACP-адаптери Claude Code і Codex містять власні бінарники агентів. Тому в архів вони не потрапляють.

Перевірити зібраний реліз: `TABHELM_RELEASE=dist/tabhelm-<версія> npm run e2e -- claude` (запускати з папки `host/`).

## Перевірка

```bash
cd host
npm run smoke -- claude     # хост + агент без Chrome (фейкова сторінка); також codex|cursor|opencode|grok|gemini
npm run e2e -- claude       # повний тест у headless Chrome: панель → агент → заповнення форми
npm run test:tools          # кожен інструмент окремо (46 перевірок) у headless Chrome, без агента
```

## Відомі обмеження

- Поки агент працює з вкладкою, Chrome показує смугу «TabHelm налагоджує цей браузер». Прибрати її можна лише прапорцем `--silent-debugger-extension-api`.
- Фонові вкладки можуть не рендеритися, тож скриншот там іноді не вдається. Решта інструментів працює.
- Позиція cross-origin iframe визначається за URL. Якщо iframe перейшов на іншу адресу, клік виконується через DOM (`isTrusted: false`), а hover і drag недоступні.
- Поле файлу всередині iframe поки не підтримується.
- Console і network збираються з моменту, коли агент уперше звернувся до вкладки. Щоб побачити події завантаження, перезавантажте сторінку (`browser_reload`).
- Якщо закрити панель, сесія агента зупиняється, а історія чату не зберігається.
- Сторінки `chrome://` і Chrome Web Store недоступні для розширень. Відкритий DevTools на тій самій вкладці блокує `chrome.debugger`.

Логи хоста: `~/.tabhelm/host.log`. Робоча папка агентів: `~/.tabhelm/workspace`.

Дослідження готових рішень, ACP, Ollama та підводних каменів: [docs/research.md](docs/research.md).
