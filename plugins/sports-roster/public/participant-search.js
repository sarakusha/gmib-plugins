const collator = new Intl.Collator("ru", {
  sensitivity: "base",
  numeric: true,
});
const normalize = (value) =>
  value.normalize("NFKC").toLocaleLowerCase("ru").replaceAll("ё", "е");

export function availablePeople(people, members) {
  const excluded = new Set(members.map((member) => member.participantId));
  return people
    .filter((person) => !excluded.has(person.id))
    .sort(
      (a, b) =>
        collator.compare(a.lastName, b.lastName) ||
        collator.compare(a.firstName, b.firstName) ||
        collator.compare(a.id, b.id),
    );
}

// Search the complete directory before limiting DOM results, including matches past the first page.
export function searchPeople(people, query, limit = 50) {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = people.filter((person) => {
    const name = normalize(`${person.lastName} ${person.firstName}`);
    return words.every((word) => name.includes(word));
  });
  return { items: matches.slice(0, limit), total: matches.length };
}
