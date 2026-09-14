// Tick data changes every 100 ms, but controls change only on a new revision
// or a change in access/integration status. Preserve DOM targets during clicks.
export const controlViewKey = (snapshot) =>
  JSON.stringify([
    snapshot.sessionId,
    snapshot.state?.id,
    snapshot.state?.revision,
    snapshot.rosterAvailable,
    snapshot.persistenceError,
    snapshot.nibusStatus,
    snapshot.nibusEnabled,
  ]);

export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function setFlag(node, property, value) {
  if (node[property] !== Boolean(value)) node[property] = Boolean(value);
}
