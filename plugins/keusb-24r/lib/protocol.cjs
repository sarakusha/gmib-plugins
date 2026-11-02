"use strict";
async function identify(connection) {
  const serial = await connection.request("$KE,SER", "#SER,");
  if (!/^#SER,[A-Za-z0-9_-]{1,64}$/.test(serial))
    throw new Error("Некорректный серийный номер KeUSB");
  const firmware = await connection.request("$KE,FW", "#FW,");
  if (!/^#FW,\d+\.\d+/.test(firmware))
    throw new Error("Некорректная версия KeUSB");
  if (Number(firmware.slice(4).split(".")[0]) < 2)
    throw new Error("Для чтения реле необходима прошивка 2.0 или новее");
  return { id: serial.slice(5), firmware: firmware.slice(4) };
}
async function read(connection) {
  const answer = await connection.request("$KE,RDR,ALL", "#RDR,ALL,");
  if (!/^#RDR,ALL,[01],[01],[01],[01]$/.test(answer))
    throw new Error("Некорректное состояние реле");
  return answer
    .split(",")
    .slice(2)
    .map((value) => value === "1");
}
async function set(connection, channel, enabled) {
  if (![1, 2, 3, 4].includes(channel) || typeof enabled !== "boolean")
    throw new Error("Некорректный выход");
  const answer = await connection.request(
    `$KE,REL,${channel},${enabled ? 1 : 0}`,
    "#REL,",
  );
  if (answer !== "#REL,OK")
    throw new Error(`Реле отклонило команду: ${answer}`);
}
module.exports = { identify, read, set };
