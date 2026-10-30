"use strict";
const fail = (message, status = 422) => {
  const error = Error(message);
  error.status = status;
  throw error;
};
const id = (value) => (Number.isSafeInteger(value) ? value : null);
function defaults(saved, screens, status) {
  const sized = screens
    .filter((s) => s.width > 0 && s.height > 0)
    .sort((a, b) => b.width - a.width);
  const wideScreenId =
    saved && Object.hasOwn(saved, "wideScreenId")
      ? id(saved.wideScreenId)
      : (sized[0]?.id ?? null);
  const compactScreenId =
    saved && Object.hasOwn(saved, "compactScreenId")
      ? id(saved.compactScreenId)
      : (sized.find((s) => s.width < sized[0].width)?.id ?? null);
  return {
    wideScreenId,
    compactScreenId,
    mode: ["wide", "compact"].includes(saved?.mode)
      ? saved.mode
      : status.profile?.screenId === compactScreenId
        ? "compact"
        : "wide",
    autoStart:
      typeof saved?.autoStart === "boolean"
        ? saved.autoStart
        : Boolean(status.profile?.autoStart),
    playerEnabled: saved?.playerEnabled === true,
    playerId: id(saved?.playerId),
  };
}
function createOutputControl({ output, getRecord, persist }) {
  output ||= {
    listScreens: async () => [],
    getStatus: async () => ({
      active: false,
      message: "Вывод недоступен в этом хосте",
    }),
    start: async () => fail("Вывод недоступен в этом хосте", 409),
    stop: async () => fail("Вывод недоступен в этом хосте", 409),
  };
  const supported =
    typeof output.listPlayers === "function" &&
    typeof output.setPlayerState === "function";
  async function state() {
    const [screens, status] = await Promise.all([
      output.listScreens(),
      output.getStatus(),
    ]);
    let players = [],
      message = "";
    if (supported) {
      try {
        players = await output.listPlayers();
      } catch (error) {
        message = `Плееры недоступны: ${error.message}`;
      }
    }
    return {
      screens,
      status,
      players,
      features: { playerControl: supported },
      config: defaults(getRecord().outputConfig, screens, status),
      ...(message ? { message } : {}),
    };
  }
  function validate(value, previous, screens, players, command) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("Проверьте настройки вывода.");
    const config = { ...value };
    if (
      !["wide", "compact"].includes(config.mode) ||
      typeof config.autoStart !== "boolean" ||
      typeof config.playerEnabled !== "boolean"
    )
      fail("Проверьте режим и параметры вывода.");
    for (const key of ["wideScreenId", "compactScreenId"]) {
      if (config[key] !== null && id(config[key]) === null)
        fail("Выберите экран GMIB.");
      if (config[key] !== null && !screens.some((s) => s.id === config[key]))
        fail("Выбранный экран удалён из GMIB.");
    }
    if (
      config.wideScreenId !== null &&
      config.wideScreenId === config.compactScreenId
    )
      fail("Широкий и компактный вывод должны использовать разные экраны.");
    if (
      command === "toggle" &&
      (config.wideScreenId === null || config.compactScreenId === null)
    )
      fail("Для переключения выберите оба экрана.");
    if (config.playerEnabled && !supported)
      fail("Обновите GMIB для управления плеером.", 409);
    if (config.playerEnabled && !players.some((p) => p.id === config.playerId))
      fail("Выберите доступный плеер.");
    return {
      wideScreenId: config.wideScreenId,
      compactScreenId: config.compactScreenId,
      mode: config.mode,
      autoStart: config.autoStart,
      playerEnabled: config.playerEnabled,
      playerId: id(config.playerId),
    };
  }
  async function command(name, input) {
    if (!["show", "hide", "toggle", "configure"].includes(name))
      fail("Неизвестная команда вывода.");
    const before = await state();
    const previous = before.config;
    const config =
      name === "hide"
        ? previous
        : validate(input, previous, before.screens, before.players, name);
    if (name === "toggle") {
      const current =
        before.status.active &&
        before.status.profile?.screenId === config.compactScreenId
          ? "compact"
          : before.status.active &&
              before.status.profile?.screenId === config.wideScreenId
            ? "wide"
            : previous.mode;
      config.mode = current === "wide" ? "compact" : "wide";
    }
    const screenId =
      config.mode === "compact" ? config.compactScreenId : config.wideScreenId;
    if (name !== "hide" && name !== "configure" && screenId === null)
      fail("Выберите экран для этого режима.");
    if (name === "configure") {
      await persist({ ...getRecord(), outputConfig: config });
      return state();
    }
    const playerIds = new Set();
    if (
      previous.playerEnabled &&
      previous.playerId !== null &&
      (name === "hide" ||
        !config.playerEnabled ||
        previous.playerId !== config.playerId ||
        config.mode === "wide")
    )
      playerIds.add(previous.playerId);
    if (
      config.playerEnabled &&
      config.playerId !== null &&
      config.mode === "wide"
    )
      playerIds.add(config.playerId);
    if (name === "hide") {
      let failure;
      for (const playerId of playerIds) {
        try {
          if (!supported) fail("Обновите GMIB для управления плеером.", 409);
          await output.setPlayerState({ playerId, playing: false });
        } catch (error) {
          failure ||= error;
        }
      }
      // A removed or broken player must never prevent hiding the clock.
      await output.stop();
      await persist({
        ...getRecord(),
        outputConfig: { ...config, autoStart: false },
      });
      if (failure) throw failure;
      return state();
    }
    if (typeof output.applyLayout === "function") {
      const players = new Map(
        [...playerIds].map((playerId) => [playerId, false]),
      );
      if (config.mode === "compact" && config.playerEnabled)
        players.set(config.playerId, true);
      const states = [...players].map(([playerId, playing]) => ({
        playerId,
        playing,
      }));
      const previousStates = before.players
        .filter((player) => players.has(player.id))
        .map((player) => ({ playerId: player.id, playing: player.playing }));
      // The host keeps the old layout in front until its replacement is ready,
      // and rolls back rejected applications. Never stop it before this call.
      await output.applyLayout({
        profile: { screenId, pageId: "screen", autoStart: config.autoStart },
        ...(states.length ? { players: states } : {}),
      });
      try {
        await persist({ ...getRecord(), outputConfig: config });
      } catch (error) {
        // Application succeeded, but saving the plugin's selection did not.
        try {
          if (before.status.active && before.status.profile) {
            await output.applyLayout({
              profile: before.status.profile,
              ...(previousStates.length ? { players: previousStates } : {}),
            });
          } else {
            await output.stop();
            for (const previousState of previousStates)
              await output.setPlayerState(previousState);
          }
        } catch (rollback) {
          throw Error(
            `${error.message} Восстановление предыдущего вывода: ${rollback.message}`,
          );
        }
        throw error;
      }
      return state();
    }
    try {
      for (const playerId of playerIds) {
        if (!supported) fail("Обновите GMIB для управления плеером.", 409);
        await output.setPlayerState({ playerId, playing: false });
      }
      // Hide the prior output before showing another, including on API 1.1 hosts.
      await output.stop();
      if (name !== "hide") {
        await output.start({
          screenId,
          pageId: "screen",
          autoStart: config.autoStart,
        });
        const status = await output.getStatus();
        if (!status.active)
          fail(status.message || "Экран не удалось показать.", 503);
        if (config.mode === "compact" && config.playerEnabled)
          await output.setPlayerState({
            playerId: config.playerId,
            playing: true,
          });
      }
      const next = {
        ...config,
        ...(name === "hide" ? { autoStart: false } : {}),
      };
      await persist({ ...getRecord(), outputConfig: next });
      return state();
    } catch (error) {
      // A failed player launch must not leave a half-applied screen selection.
      try {
        if (config.playerEnabled && supported && config.mode === "compact")
          await output.setPlayerState({
            playerId: config.playerId,
            playing: false,
          });
        await output.stop();
        if (before.status.active && before.status.profile) {
          await output.start(before.status.profile);
          if (
            previous.mode === "compact" &&
            previous.playerEnabled &&
            supported
          )
            await output.setPlayerState({
              playerId: previous.playerId,
              playing: true,
            });
        }
      } catch (rollback) {
        throw Error(
          `${error.message} Восстановление предыдущего вывода: ${rollback.message}`,
        );
      }
      throw error;
    }
  }
  async function restore() {
    const current = await state();
    if (
      current.config.autoStart &&
      current.status.active &&
      current.config.playerEnabled &&
      supported
    )
      await output.setPlayerState({
        playerId: current.config.playerId,
        playing: current.config.mode === "compact",
      });
  }
  return { state, command, restore };
}
module.exports = { createOutputControl };
