# gmib plugins

Официальные плагины и публичный каталог для
[gmib](https://github.com/sarakusha/gmib).

## Каталог

gmib загружает каталог по стабильному адресу:

```text
https://raw.githubusercontent.com/sarakusha/gmib-plugins/main/catalog.json
```

Индекс генерируется из `plugins/*/manifest.json`. Готовые архивы хранятся в GitHub Releases этого
репозитория. GitHub Pages публикует дополнительную копию каталога.

## Плагины

- [`icehockey`](plugins/icehockey/README.md) — самостоятельный хоккейный пульт и LED-табло; составы необязательны;
- [`sports-roster`](plugins/sports-roster/README.md) — общая база команд и составов, локальная PWA;
- `parking-counter` — минимальный полный пример со страницей вывода и управления;
- `shader-screensavers` — адаптивные WebGL-заставки;
- `yoshka-esh` — портретное парковочное табло с фирменным оформлением.

## Проверка и сборка

```sh
pnpm install
pnpm validate
pnpm build
pnpm build:catalog
```

Архивы появятся в `dist`, итоговый индекс — в `catalog.json` и `site/index.json`. Сборка
воспроизводима на разных ОС: служебные файлы исключаются, а timestamps и файловые атрибуты ZIP
фиксируются.

## Публикация версии

До первой пубикации манифест остаётся на `1.0.0`: локальные итерации не считаются релизами.
Кеш service worker версионируется независимо, например `icehockey-ui-1`; номер меняется при изменении
кешируемой PWA-оболочки.

1. Обновите `version` в `plugins/<plugin-id>/manifest.json`.
2. Проверьте проект командой `pnpm validate`.
3. Создайте и отправьте тег `<plugin-id>-v<version>`.

Например:

```sh
git tag parking-counter-v1.0.1
git push origin parking-counter-v1.0.1
```

GitHub Actions проверит соответствие тега манифесту, соберёт `.gmib-plugin` и создаст GitHub Release.
Каталог публикуется через GitHub Pages при попадании изменений манифеста в `main`.

Подробная спецификация Plugin API и требования к содержимому находятся в [AGENTS.md](AGENTS.md),
полные переносимые типы — в [gmib-plugin-api.d.ts](gmib-plugin-api.d.ts).

## Plugin API 1.1

Поддерживаются `dependencies`, `contributes.sports` и `localOnly`. Хост предоставляет SQLite,
сервисы зависимостей, монотонные часы и cleanup; актуальные контракты находятся в
`gmib-plugin-api.d.ts`. Старые плагины с `^1.0.0` сохраняют совместимость.
SQLite-драйвер поставляет gmib: нативные зависимости в архив плагина добавлять не нужно.

## Документация и проверка

Инструкции по запуску, возможностям и ограничениям находятся в `README.md` каждого плагина;
общий README описывает только каталог, SDK, сборку и публикацию. Если README есть, сборщик
включает его в архив плагина. `pnpm test` запускает сценарии SQLite и спортивного состояния
на Node 24+; нативных runtime-зависимостей эти тесты в плагины не добавляют.

План дальнейшего развития спортивных плагинов: [регламенты, общие библиотеки и темы](docs/sports-evolution-plan.md).
Документ отделяет проверенное поведение Matchpad от предлагаемых изменений.
