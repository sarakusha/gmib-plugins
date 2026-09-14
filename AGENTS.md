# Создание плагинов gmib

Этот файл — самодостаточная инструкция для coding-агентов, которые создают официальные плагины gmib
Plugin API 1.0 в каталоге `plugins`, не читая исходный код gmib. `AGENTS.md` — правильное имя: агенты
автоматически применяют его ко всем вложенным каталогам. Полные переносимые TypeScript-типы также
лежат рядом в `gmib-plugin-api.d.ts`.

## Задача агента

По описанию пользователя создавай отдельный каталог `plugins/<plugin-id>`. Готовый к установке архив
`<plugin-id>.gmib-plugin` создаётся общей командой `pnpm build`. Сначала уточняй только действительно
недостающие продуктовые требования; технические решения принимай по этой спецификации самостоятельно.

Готовый результат должен:

- содержать `manifest.json` в корне каталога и архива;
- работать автономно, без CDN и без установки зависимостей на машине с gmib;
- содержать уже собранный CommonJS backend, если указан `main`;
- запрашивать только реально используемые разрешения;
- корректно работать после перезапуска gmib;
- не включать исходные карты, секреты, `.env`, служебные файлы ОС, `node_modules` и инструменты
  сборки;
- быть проверен как каталог и как ZIP-архив перед передачей пользователю.

Не изменяй существующие примеры, если пользователь явно не попросил об этом. Не придумывай
недокументированные API gmib. Backend имеет права процесса gmib, поэтому не добавляй произвольное
чтение файлов, запуск процессов, сетевую телеметрию или загрузку исполняемого кода без явной задачи
пользователя.

## Минимальная структура

```text
<plugin-id>/
├── manifest.json
├── dist/
│   └── main.cjs       # только если нужен backend
└── public/            # только если нужны страницы/ресурсы
    ├── screen.html
    ├── control.html
    ├── app.js
    └── app.css
```

Статическому плагину не нужен `main`. Плагину без страниц не нужны `public`, `pages` и `control`.
`control` — страница управления, открываемая кнопкой в списке плагинов. `pages` — страницы, которые
gmib добавляет в раздел «Вывод».

## Манифест

```ts
type PluginPermission = 'http.routes' | 'storage' | 'realtime' | 'output.pages';

type PluginOutputPage = {
  id: string;
  title: string;
  path: string; // относительно каталога public
};

type PluginControlPage = {
  title?: string;
  path: string; // относительно каталога public
};

type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  gmibApi: string;
  main?: string; // относительно корня плагина
  public?: string; // относительно корня плагина
  permissions?: PluginPermission[];
  pages?: PluginOutputPage[];
  control?: PluginControlPage;
};
```

Полный пример:

```json
{
  "id": "parking-counter",
  "name": "Счётчик парковки",
  "version": "1.0.0",
  "description": "Показывает количество свободных мест.",
  "gmibApi": "^1.0.0",
  "main": "dist/main.cjs",
  "public": "public",
  "permissions": ["http.routes", "storage", "realtime", "output.pages"],
  "pages": [
    {
      "id": "screen",
      "title": "Парковка/Свободные места",
      "path": "screen.html"
    }
  ],
  "control": {
    "title": "Управление",
    "path": "control.html"
  }
}
```

Правила валидации:

- `id` обязателен, уникален для установки и совпадает с `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`:
  1–64 символа, только строчные латинские буквы, цифры и дефисы, дефис не может быть первым или
  последним;
- `pages[].id` подчиняется тому же шаблону и не повторяется внутри манифеста;
- `name`, `description`, `pages[].title` и заданный `control.title` — непустые строки;
- `version` — точная корректная SemVer-версия, например `1.2.0`;
- до первой пубикации не поднимай `version` за локальные итерации; кеш service worker версионируй
  отдельным ключом `<plugin-id>-ui-<revision>`;
- `gmibApi` — корректный SemVer-диапазон, который включает установленный API `1.0.0`; обычно
  указывай `^1.0.0`;
- разрешения не повторяются; неизвестные разрешения запрещены;
- при наличии `pages` или `control` обязательно поле `public`;
- при наличии `pages` обязательно разрешение `output.pages`;
- `main`, `public`, пути страниц и control должны существовать, быть относительными, не выходить из
  каталога плагина, не быть абсолютными/Windows drive paths и не проходить через символические
  ссылки;
- все `pages[].path` и `control.path` считаются относительно `public`, а `main` — относительно корня
  плагина.

Не добавляй неизвестные поля «на будущее»: gmib нормализует манифест и не передает их backend-коду.

## Разрешения

| Разрешение     | Что открывает                                    |
| -------------- | ------------------------------------------------ |
| `http.routes`  | `context.http.get/post/put/patch/delete`         |
| `storage`      | `context.storage.get/set/update`                 |
| `realtime`     | `context.events.publish`                         |
| `output.pages` | `manifest.pages` и `context.output.registerPage` |

`logger`, `apiVersion` и чтение `context.plugin` отдельного разрешения не требуют. Наличие
разрешения показывается пользователю при установке, но не делает API-вызов автоматически: backend
должен сам зарегистрировать маршруты и публиковать события.

## Полные типы backend API 1.0

Следующие объявления нормативны для кода плагина и продублированы в `gmib-plugin-api.d.ts`:

```ts
type PluginHttpAccess = 'local' | 'authenticated';
type PluginHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

type PluginHttpRequest = {
  method: PluginHttpMethod;
  path: string;
  query: Record<string, string | string[]>;
  body: unknown;
};

type PluginHttpResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

type PluginHttpHandler = (request: PluginHttpRequest) => unknown | Promise<unknown>;

type PluginHttpRouteOptions = {
  access?: PluginHttpAccess;
};

type PluginHttpRegistrar = (
  route: string,
  handler: PluginHttpHandler,
  options?: PluginHttpRouteOptions,
) => void;

type PluginLogger = {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

type PluginContext = {
  apiVersion: string;
  plugin: Readonly<PluginManifest>;
  logger: PluginLogger;
  http: {
    delete: PluginHttpRegistrar;
    get: PluginHttpRegistrar;
    patch: PluginHttpRegistrar;
    post: PluginHttpRegistrar;
    put: PluginHttpRegistrar;
    response: (
      status: number,
      body?: unknown,
      headers?: Record<string, string>,
    ) => PluginHttpResponse;
  };
  storage: {
    get: <T = unknown>(key: string, defaultValue?: T) => Promise<T | undefined>;
    set: (key: string, value: unknown) => Promise<void>;
    update: <T = unknown>(key: string, updater: (value: T | undefined) => T) => Promise<T>;
  };
  events: {
    publish: (event: string, data?: unknown) => void;
  };
  output: {
    registerPage: (page: PluginOutputPage) => Promise<void>;
  };
};

type PluginActivate = (context: PluginContext) => void | Promise<void>;

type PluginModule = {
  activate?: PluginActivate;
  default?: { activate?: PluginActivate };
};
```

Backend загружается через CommonJS `require`. Итоговый файл должен экспортировать либо
`exports.activate = async context => { ... }`, либо `module.exports.default = { activate }`.
Предпочтителен первый вариант. ESM-only файл с `export` не подойдет. Вызов `activate` должен
завершать регистрацию; API деактивации в версии 1.0 нет, изменения требуют перезапуска gmib.

Минимальный backend:

```js
'use strict';

/** @param {import('../../gmib-plugin-api').PluginContext} context */
exports.activate = async context => {
  const { events, http, storage } = context;
  const initial = await storage.get('value');
  if (typeof initial !== 'number') await storage.set('value', 0);

  http.get('/state', async () => ({ value: await storage.get('value', 0) }));
  http.put('/state', async request => {
    const body = request.body;
    const value = Number(
      body && typeof body === 'object' && 'value' in body ? body.value : Number.NaN,
    );
    if (!Number.isFinite(value)) return http.response(400, { error: 'value must be a number' });
    await storage.set('value', value);
    events.publish('changed', { value });
    return { value };
  });
};
```

Путь в JSDoc нужен только при разработке и не создает runtime-зависимость. Если исходник находится
на другой глубине, скорректируй путь или скопируй `gmib-plugin-api.d.ts` рядом. В собранном архиве
этот файл не обязателен.

## HTTP

Маршрут обязан начинаться с `/`, не может содержать `?` или `#`, нормализуется как POSIX-путь и
сопоставляется точно. Параметры вида `/:id`, маски и wildcard-маршруты API 1.0 не поддерживает.
Одинаковые `method + path + access` нельзя регистрировать дважды.

По умолчанию `{ access: 'local' }`:

```text
GET http://127.0.0.1:<port>/plugins/<plugin-id>/api/state
```

Такой запрос принимается только с loopback-интерфейса. Со страницы плагина используй относительный
URL — например, `fetch('api/state')` со страницы `screen.html`.

С `{ access: 'authenticated' }` маршрут становится частью удаленного REST API:

```text
GET /api/plugins/<plugin-id>/state
```

К нему применяется обычная авторизация gmib. Не реализуй собственный обход авторизации. Страница
плагина обычно должна использовать локальный маршрут; `authenticated` выбирай только когда
пользователь явно требует внешнюю интеграцию.

`request.query` содержит только строковые значения и массивы строк. `request.body` — `unknown`; gmib
разбирает JSON и URL-encoded тела, но backend обязан проверять тип, диапазоны и обязательные поля.

Возвращаемые значения:

- `undefined` → HTTP 204;
- строка или `Buffer` → тело как есть;
- обычное значение → JSON;
- `http.response(status, body, headers)` → явные статус, тело и строковые заголовки.

Объект, содержащий хотя бы одно собственное поле `status`, `headers` или `body`, трактуется как
`PluginHttpResponse`. Если такие имена нужны в JSON предметной области, оборачивай его:
`http.response(200, domainObject)`.

Не полагайся на исключения как на формат пользовательской ошибки: проверяемые ошибки возвращай явно,
например `http.response(422, { error: '...' })`.

## Постоянное хранилище

Ключ соответствует `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`. Храни только значения, которые безопасно
проходят `structuredClone` и преобразование в JSON: `null`, boolean, конечные числа, строки, массивы
и простые объекты. Не храни функции, `undefined`, `BigInt`, циклические структуры, секреты в
открытом виде или большие бинарные данные.

- `get(key)` возвращает `undefined`, если ключа нет;
- `get(key, fallback)` возвращает fallback, не записывая его;
- `set` сохраняет значение атомарной заменой файла состояния;
- `update` последовательно выполняется относительно других записей этого экземпляра плагина и нужна
  для read-modify-write без потерянных обновлений; updater синхронный и должен вернуть новое
  значение.

Данные лежат отдельно от файлов плагина, переживают обновление и удаление плагина и снова доступны
после установки плагина с тем же `id`. Поэтому мигрируй схему данных при повышении версии, если ее
формат меняется.

## Realtime и frontend

`events.publish(name, payload)` принимает имя по шаблону `^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$` и
рассылает всем WebSocket-клиентам сообщение:

```ts
type PluginEventMessage<T = unknown> = {
  event: `plugin:${string}:${string}`; // plugin:<plugin-id>:<name>
  data: [T | null];
};
```

Для браузерной страницы подключай WebSocket к тому же origin. Первым сообщением можно передать
числовой `sourceId`; для plugin-событий это не обязательно, но совместимо с общим протоколом gmib.
Фильтруй сообщения по полному имени события, проверяй входные данные и повторно подключайся после
разрыва:

```js
const connect = () => {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}`);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ sourceId: Date.now() }));
  });
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.event === 'plugin:my-plugin:changed') render(message.data?.[0]);
    } catch {
      // Сообщение другой подсистемы или некорректные данные.
    }
  });
  socket.addEventListener('close', () => setTimeout(connect, 1500));
};
```

Статические файлы доступны как `/plugins/<plugin-id>/<path-inside-public>`. Используй относительные
ссылки на CSS, JS, изображения и API, чтобы не знать порт gmib. Не используй CDN: экран может
работать без интернета. Учитывай, что output-страница может долго оставаться открытой, менять размер
и работать на нестандартном соотношении сторон; освобождай таймеры, ограничивай повторные запросы и
показывай состояние потери связи. Для показа на экране обычно нужен прозрачный фон, если
пользователь не просил иной.

## Динамические output-страницы

`context.output.registerPage({ id, title, path })` применяет те же правила, что элемент `pages`:
нужны `output.pages`, каталог `public`, допустимый уникальный `id`, непустой `title` и существующий
файл относительно `public`. Вызов асинхронный. Обычно объявляй постоянный набор страниц прямо в
манифесте; динамическую регистрацию используй, только если состав страниц определяется при
активации.

Внутренний id страницы имеет вид `plugin:<plugin-id>:<page-id>`. Не используй этот id как публичный
URL. При отключении/удалении плагина устаревшие output-страницы удаляются gmib автоматически.

## Логирование и ошибки

`logger.debug/info/warn/error(...args)` приводит каждый аргумент к строке и объединяет через пробел.
Не рассчитывай на структурированное логирование объектов: преобразуй безопасные диагностические поля
сам. Не записывай токены, пароли, персональные данные и содержимое всего request body. Ошибка из
`activate` делает плагин незагруженным; поэтому проверяй конфигурацию и регистрируй маршруты
предсказуемо.

## Сборка и архив

Установка не запускает `npm install`. Все npm-зависимости backend должны быть встроены в один или
несколько файлов внутри плагина, а точкой входа остается CommonJS-файл из `main`. Node built-ins
технически доступны доверенному backend, но это не часть специализированного Plugin API и
использовать их следует только по явной необходимости.

`.gmib-plugin` — обычный ZIP, у которого `manifest.json` лежит непосредственно в корне, без внешней
папки `<plugin-id>/`. Ограничения установщика:

- архив не более 50 МиБ;
- не более 2000 записей;
- один распакованный файл не более 50 МиБ;
- суммарный распакованный размер не более 200 МиБ;
- повторяющиеся пути, абсолютные пути, `..`, NUL, Windows drive paths и символические ссылки
  запрещены.

Пример упаковки из каталога плагина:

```sh
zip -r ../my-plugin.gmib-plugin manifest.json dist public \
  -x '*.DS_Store' '*.map' '*/node_modules/*'
```

Для статического плагина убери `dist`; при отсутствии страниц убери `public`. Не архивируй сам
каталог вместо его содержимого.

## Обязательная проверка результата

Перед передачей пользователю:

1. Проверь JSON-синтаксис `manifest.json`, SemVer, id, разрешения и существование всех объявленных
   путей.
2. Проверь, что backend — CommonJS, экспортирует `activate`, не оставляет внешних npm-импортов и не
   обращается к API без соответствующего permission.
3. Проверь frontend без CDN, абсолютного порта и жестко заданного чужого plugin id.
4. Проверь обработку пустого состояния, некорректного body, сетевых ошибок и повторного WebSocket
   подключения.
5. Просмотри список ZIP-записей: `manifest.json` должен быть в корне, секретов и лишних файлов быть
   не должно.
6. Если доступен gmib, установи архив через «Плагины», перезапусти приложение и проверь страницу
   управления, каждую output-страницу, сохранение состояния и realtime. При ручном запуске Electron
   используй настоящий gmib user data directory; изолированный профиль скрывает activation-gated
   возможности и не является валидной проверкой.

В отчете пользователю перечисли созданный каталог и архив, кратко опиши разрешения и выполненные
проверки. После существенного изменения предложи Conventional Commit, например:
`feat(plugins): add <plugin-name> example`.

## Эталонные примеры

- `parking-counter` — минимальный полный цикл: backend, storage, local HTTP, WebSocket, control и
  output-страница;
- `yoshka-esh` — адаптивное портретное табло с расширенной формой настройки и ресурсами.
  <!-- cspell:ignore yoshka -->

Примеры помогают с композицией, но эта инструкция и `gmib-plugin-api.d.ts` являются достаточной
спецификацией API 1.0. Не требуется и не следует читать исходники gmib, чтобы выполнить обычную
задачу создания плагина.

## Расширения API 1.1

Для новых спортивных плагинов используйте `gmibApi: "^1.1.0"` и актуальные типы
`gmib-plugin-api.d.ts`; разделы выше описывают совместимый API 1.0.

- `dependencies` и `optionalDependencies`: объект pluginId → SemVer-диапазон. Обязательная
  зависимость загружается первой; отсутствие/ошибка необязательной не блокирует потребителя.
- `contributes.sports`: массив `{ id, name, rosterVersion, positions: [{ id, name }] }`.
  Список доступен через `context.plugins.listSports()` с permission `plugins.read`, ещё до активации
  всех видов; проверяйте `ready` перед использованием backend спорта.
- `localOnly: true`: страницы и realtime доступны только локально; HTTP-маршруты только `local`.
- `database`: `context.database.open(name, migrations)`; миграции `{ version, sql }` с 1 подряд.
  База предоставляет `all/get/run/transaction`. В callback транзакции используйте только `tx`
  и ожидайте все операции. Применённые миграции неизменяемы. Драйвер предоставляет gmib.
- `services.provide`: `context.services.provide(name, version, object)`.
- `services.consume`: `context.services.require(pluginId, name, range)`; зависимость должна быть
  объявлена. Для optionalDependencies обрабатывайте недоступность сервиса, сохраняя ручной режим.
- `context.clock.now()` — монотонные миллисекунды, `onSuspend/onResume` возвращают unsubscribe.
- `context.lifecycle.onDispose(callback)` вызывается при ошибке активации и выходе в обратном порядке
  регистрации; здесь очищайте интервалы и сохраняйте финальное состояние. Базы закрывает хост.

`icehockey` должен работать без `sports-roster`: ручные команды, часы и штрафы по номеру игрока.
Справочник составов — исключительно необязательное расширение.

### Вывод и NiBUS API 1.1

`output.control` предоставляет `listScreens/getStatus/start/stop`. Профиль `{ screenId, pageId,
autoStart }` ссылается на настроенный экран gmib и страницу этого плагина. Создание геометрии остаётся
в gmib. `start` не означает, что отключённый физический дисплей уже показывает изображение;
проверяйте `getStatus`.

`nibus.read`: `listConnections`, `onConnectionChange`, `onInformationReport(filter, callback)`.
События типизированы как timer/score/period/teamName/penalties; RAW-датаграмм нет.
`nibus.write`: `acquireOutput({ connectionId, target, profile: 'matchpad' })` возвращает
`sendTimer/sendScoreboard/sendPenalties/sendTeams/release`. Успех означает постановку в очередь.
Профиль поддерживает два штрафа на сторону, BCD-номера 0–99; валидируйте ограничения в UI.
Горячая переустановка не поддерживается. Ресурсы освобождаются хостом при завершении плагина.

У каждого нового плагина обязателен собственный `README.md`: назначение, запуск, возможности,
настройки, хранение данных, ограничения и проверка. Общий README содержит каталог и общие правила.

### Общая спортивная логика

Перед созданием или изменением вида спорта прочитайте `docs/matchpad/common.md` и документ
этого вида в `docs/matchpad/`. Фиксируйте там проверенное поведение Matchpad и явно отмечайте
сознательные различия плагина. Обновляйте описание вместе с изменением спортивной логики.

Повторно используемые состояние и алгоритмы размещайте в `packages/sports-core`, функции
представления — в `packages/sports-ui`. Плагин перечисляет автономные runtime-копии в
`sports-libraries.json`. После изменения общей библиотеки выполните `pnpm sync:sports`;
`pnpm validate` отклоняет устаревшую копию. Не импортируйте файлы за пределами каталога
плагина во время исполнения: установленный архив должен оставаться самодостаточным.

Основной и вторичный таймеры храните отдельно. Командный тайм-аут не должен скрывать или
заменять игровое время. Лимит и использованное количество передавайте данными регламента,
не зашивайте `0/1` в общий компонент. Целые секунды удалений синхронизируйте с фазой игрового
таймера; при остатке меньше секунды выводите десятые без фазовой поправки и убирайте строку при нуле.
