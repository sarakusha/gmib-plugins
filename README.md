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
