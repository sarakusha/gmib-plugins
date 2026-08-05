# gmib plugins

Официальные плагины и публичный каталог для
[gmib](https://github.com/sarakusha/gmib).

## Каталог

gmib загружает каталог по стабильному адресу:

```text
https://sarakusha.github.io/gmib-plugins/index.json
```

Индекс генерируется из `plugins/*/manifest.json`. Готовые архивы хранятся в GitHub Releases этого
репозитория.

## Плагины

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

Архивы появятся в `dist`, итоговый индекс — в `site/index.json`. Сборка воспроизводима: служебные
файлы исключаются, а timestamps ZIP фиксируются.

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
