(function (root) {
  "use strict";
  function formatDate(now, date, clock) {
    const options = { ...date.options };
    const weekdayStyle = date.weekday ? options.weekday || "long" : undefined;
    delete options.weekday;
    const zone = { timeZone: clock.timeZone };
    const weekday = weekdayStyle
      ? new Intl.DateTimeFormat(clock.locale, {
          ...zone,
          weekday: weekdayStyle,
        }).format(now)
      : "";
    // An empty Intl options object would silently enable day, month and year.
    let calendar = "";
    if (Object.keys(options).length) {
      const parts = new Intl.DateTimeFormat(clock.locale, {
        ...options,
        ...zone,
      }).formatToParts(now);
      const enabled = (part) =>
        part.type !== "literal" &&
        part.type !== "weekday" &&
        (options.dateStyle || options[part.type]);
      calendar = parts
        .filter((part, i) => {
          if (part.type !== "literal") return enabled(part);
          // Keep locale punctuation only beside enabled fields, never hidden defaults.
          const before = parts
            .slice(0, i)
            .findLast((p) => p.type !== "literal");
          const after = parts.slice(i + 1).find((p) => p.type !== "literal");
          return before && enabled(before) && (!after || enabled(after));
        })
        .map((part) => part.value)
        .join("")
        .trim();
    }
    const capitalize = (value) =>
      value ? value[0].toLocaleUpperCase(clock.locale) + value.slice(1) : "";
    return {
      weekday: capitalize(weekday),
      calendar: weekday ? calendar : capitalize(calendar),
    };
  }
  if (typeof module === "object" && module.exports)
    module.exports = { formatDate };
  else root.InformerDate = { formatDate };
})(typeof globalThis === "object" ? globalThis : this);
