(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const FORMAT = "gmib-informer-theme";
  const MAX_FILE_BYTES = 512 * 1024;
  window.InformerThemes = {
    init({ api, show, getDraft, setDraft, canUse }) {
      let themes = [],
        available = false,
        busy = false;
      const select = $("theme-select");
      function controls() {
        for (const id of [
          "theme-save",
          "theme-export",
          "theme-file",
          "theme-select",
        ])
          $(id).disabled = busy || !available || !canUse();
        for (const id of ["theme-load", "theme-delete"])
          $(id).disabled = busy || !available || !canUse() || !select.value;
      }
      function catalog(data, selected = select.value) {
        if (!Array.isArray(data?.themes))
          throw Error("Не удалось прочитать список тем.");
        themes = data.themes;
        select.replaceChildren();
        select.add(
          new Option(themes.length ? "Выберите тему" : "Тем пока нет", ""),
        );
        for (const theme of themes)
          select.add(new Option(theme.name, theme.name));
        select.value = themes.some((theme) => theme.name === selected)
          ? selected
          : "";
        $("theme-status").textContent =
          `Сохранено тем: ${themes.length} из 50.`;
        controls();
      }
      async function run(work) {
        if (busy || !available || !canUse()) return;
        busy = true;
        controls();
        try {
          await work();
        } catch (error) {
          show(error.message, true);
        } finally {
          busy = false;
          controls();
        }
      }
      function currentTheme() {
        const name = $("theme-name").value.normalize("NFC").trim();
        if (
          !name ||
          Array.from(name).length > 80 ||
          /[\p{Cc}\p{Cf}]/u.test(name)
        )
          throw Error("Укажите название темы: от 1 до 80 символов.");
        return { format: FORMAT, version: 1, name, settings: getDraft() };
      }
      select.addEventListener("change", controls);
      $("theme-save").addEventListener("click", () =>
        run(async () => {
          const file = currentTheme();
          const data = await api("themes", "POST", file);
          catalog(data, data.theme.name);
          $("theme-name").value = data.theme.name;
          show("Тема сохранена на этом устройстве GMIB.");
        }),
      );
      $("theme-load").addEventListener("click", () =>
        run(async () => {
          // Refresh before loading: another control page may have replaced the theme.
          const name = select.value;
          catalog(await api("themes"), name);
          const theme = themes.find((theme) => theme.name === name);
          if (!theme)
            throw Error("Тема больше не существует. Выберите другую.");
          setDraft(theme.settings);
          $("theme-name").value = theme.name;
          show(
            "Тема загружена в предпросмотр. Нажмите «Применить» для вывода на экран.",
          );
        }),
      );
      $("theme-delete").addEventListener("click", () =>
        run(async () => {
          const name = select.value;
          catalog(await api("themes", "DELETE", { name }));
          show("Тема удалена. Текущие настройки не изменились.");
        }),
      );
      $("theme-export").addEventListener("click", () =>
        run(async () => {
          const file = currentTheme();
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(file, null, 2) + "\n"], {
              type: "application/json",
            }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = `${file.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 80) || "informer"}.informer-theme.json`;
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          show("Текущие настройки экспортированы в JSON.");
        }),
      );
      $("theme-file").addEventListener("change", () =>
        run(async () => {
          const input = $("theme-file"),
            file = input.files?.[0];
          if (!file) return;
          try {
            if (file.size > MAX_FILE_BYTES)
              throw Error("Файл темы слишком большой (не более 512 КБ).");
            let body;
            try {
              body = JSON.parse(await file.text());
            } catch {
              throw Error("Файл не содержит корректный JSON темы.");
            }
            if (body?.format !== FORMAT || body.version !== 1)
              throw Error("Неподдерживаемый формат или версия темы Informer.");
            // Validation and persistence happen together on the device; invalid imports
            // never replace the current draft or an existing theme.
            const data = await api("themes", "POST", body);
            catalog(data, data.theme.name);
            setDraft(data.theme.settings);
            $("theme-name").value = data.theme.name;
            show(
              "Тема импортирована и загружена в предпросмотр. Нажмите «Применить» для вывода на экран.",
            );
          } finally {
            input.value = "";
          }
        }),
      );
      const reload = () =>
        api("themes")
          .then((data) => {
            available = true;
            catalog(data);
          })
          .catch(() => {
            available = false;
            controls();
            $("theme-status").textContent =
              "Хранилище тем недоступно. После обновления плагина перезапустите GMIB и обновите страницу.";
          });
      reload();
      return { refresh: controls, reload };
    },
  };
})();
