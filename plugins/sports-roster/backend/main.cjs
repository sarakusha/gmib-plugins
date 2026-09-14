'use strict';
const { randomUUID } = require('node:crypto');
const migrations = [{ version: 1, sql: `
CREATE TABLE sports(id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL);
CREATE TABLE teams(id TEXT PRIMARY KEY, sportId TEXT NOT NULL REFERENCES sports(id), name TEXT NOT NULL,
 shortName TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#40d9ac',
 logo TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE participants(id TEXT PRIMARY KEY, firstName TEXT NOT NULL DEFAULT '', lastName TEXT NOT NULL);
CREATE TABLE team_members(teamId TEXT NOT NULL REFERENCES teams(id), participantId TEXT NOT NULL REFERENCES participants(id),
 number TEXT, position TEXT NOT NULL DEFAULT '', captain INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(teamId,participantId), UNIQUE(teamId,number));
` }];
const fail = (message, status = 422) => { const error = new Error(message); error.status = status; throw error; };
const text = (value, label, max = 100, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`Проверьте поле «${label}»`);
  return value.trim();
};
const id = value => text(value, 'идентификатор', 100, true);
const bodyObject = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Ожидается объект'); return value; };
const logo = value => {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 350000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) fail('Эмблема: PNG, JPEG или WebP до 250 КБ');
  return value;
};
const teamData = value => {
  const b = bodyObject(value);
  const color = b.color ?? '#40d9ac';
  if (!/^#[a-f0-9]{6}$/i.test(color)) fail('Некорректный цвет');
  return { id: b.id ? id(b.id) : randomUUID(), sportId: id(b.sportId), name: text(b.name, 'команда', 100, true),
    shortName: text(b.shortName ?? '', 'сокращение', 24), city: text(b.city ?? '', 'город'), color,
    logo: logo(b.logo ?? ''), archived: b.archived === true || b.archived === 1 ? 1 : 0 };
};
const memberData = value => {
  const b = bodyObject(value);
  const number = text(b.number ?? '', 'номер', 5);
  return { teamId: id(b.teamId), participantId: b.participantId ? id(b.participantId) : randomUUID(),
    firstName: text(b.firstName ?? '', 'имя', 80), lastName: text(b.lastName, 'фамилия', 100, true),
    number: number || null, position: text(b.position ?? '', 'позиция', 64), captain: b.captain ? 1 : 0, active: b.active === false || b.active === 0 ? 0 : 1 };
};
exports.activate = async context => {
  const { http, events } = context;
  const db = await context.database.open('rosters', migrations);
  const available = () => context.plugins.listSports();
  const syncSports = async () => {
    for (const sport of available()) await db.run('INSERT INTO sports VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition', [sport.id, sport.name, JSON.stringify(sport)]);
  };
  await syncSports();
  const sports = async () => {
    await syncSports();
    const installed = available();
    return (await db.all('SELECT * FROM sports ORDER BY name')).map(row => installed.find(sport => sport.id === row.id) ?? { ...JSON.parse(row.definition), installed: false, enabled: false, ready: false });
  };
  const listTeams = async sportId => db.all('SELECT * FROM teams WHERE archived=0 AND sportId=? ORDER BY name', [id(sportId)]);
  const getTeam = async teamId => db.get('SELECT * FROM teams WHERE id=?', [id(teamId)]);
  const listMembers = async teamId => db.all(`SELECT m.*, p.firstName, p.lastName FROM team_members m JOIN participants p ON p.id=m.participantId WHERE m.teamId=? ORDER BY CAST(m.number AS INTEGER), m.number, p.lastName`, [id(teamId)]);
  const createRosterSnapshot = async (teamId, selectedIds) => {
    const team = await getTeam(teamId);
    if (!team || team.archived) fail('Команда недоступна');
    let members = (await listMembers(teamId)).filter(member => member.active);
    if (selectedIds !== undefined) {
      if (!Array.isArray(selectedIds) || selectedIds.some(value => !members.some(member => member.participantId === value))) fail('Некорректная заявка');
      members = members.filter(member => selectedIds.includes(member.participantId));
    }
    return structuredClone({ ...team, members });
  };
  context.services.provide('sports.rosters', '1.0.0', { listTeams, getTeam, listMembers, createRosterSnapshot });
  const route = handler => async request => {
    try { return http.response(200, await handler(request)); }
    catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT') || (error.errcode & 255) === 19) return http.response(409, { error: 'Номер или участник уже есть в составе. Проверьте связи данных.' });
      if (!error.status) context.logger.error('Roster operation failed', error.code ?? error.name);
      return http.response(error.status ?? 500, { error: error.status ? error.message : 'Не удалось сохранить данные' });
    }
  };
  const checkSport = async sportId => {
    const sport = available().find(item => item.id === sportId && item.ready);
    if (!sport) fail('Вид спорта недоступен. Установите и включите спортивный плагин.');
    return sport;
  };
  const writeTeam = async (tx, team) => tx.run(`INSERT INTO teams VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,shortName=excluded.shortName,city=excluded.city,color=excluded.color,logo=excluded.logo,archived=excluded.archived`, Object.values(team));
  const writeMember = async (tx, member) => {
    await tx.run('INSERT INTO participants VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET firstName=excluded.firstName,lastName=excluded.lastName', [member.participantId, member.firstName, member.lastName]);
    await tx.run('INSERT INTO team_members VALUES (?,?,?,?,?,?) ON CONFLICT(teamId,participantId) DO UPDATE SET number=excluded.number,position=excluded.position,captain=excluded.captain,active=excluded.active', [member.teamId, member.participantId, member.number, member.position, member.captain, member.active]);
  };
  http.get('/sports', route(sports));
  http.get('/teams', route(request => listTeams(request.query.sportId)));
  http.get('/members', route(request => listMembers(request.query.teamId)));
  http.get('/participants', route(() => db.all('SELECT * FROM participants ORDER BY lastName,firstName')));
  http.put('/teams', route(async request => {
    const team = teamData(request.body);
    await checkSport(team.sportId);
    const old = await getTeam(team.id);
    if (old && old.sportId !== team.sportId) fail('Вид спорта команды нельзя изменить');
    await writeTeam(db, team);
    events.publish('changed', { sportId: team.sportId });
    return team;
  }));
  http.put('/members', route(async request => {
    const member = memberData(request.body);
    const team = await getTeam(member.teamId);
    if (!team || team.archived) fail('Команда не найдена');
    const sport = await checkSport(team.sportId);
    if (member.position && !sport.positions.some(position => position.id === member.position)) fail('Неизвестная позиция');
    await db.transaction(tx => writeMember(tx, member));
    events.publish('changed', { sportId: team.sportId });
    return member;
  }));
  http.get('/backup', route(async () => db.transaction(async tx => ({
    format: 'gmib-sports-roster', version: 1,
    sports: await tx.all('SELECT * FROM sports'), teams: await tx.all('SELECT * FROM teams'),
    participants: await tx.all('SELECT * FROM participants'), members: await tx.all('SELECT * FROM team_members'),
  }))));
  http.post('/restore', route(async request => {
    const b = bodyObject(request.body);
    if (b.format !== 'gmib-sports-roster' || b.version !== 1) fail('Неизвестный формат резервной копии');
    for (const key of ['sports', 'teams', 'participants', 'members']) if (!Array.isArray(b[key]) || b[key].length > 10000) fail('Некорректная резервная копия');
    const definitions = b.sports.map(sport => ({ id: id(sport.id), name: text(sport.name, 'спорт', 100, true), definition: JSON.stringify({ id: id(sport.id), name: sport.name, positions: [], installed: false, ready: false, enabled: false }) }));
    const teams = b.teams.map(teamData);
    const people = new Map(b.participants.map(person => [id(person.id), person]));
    const members = b.members.map(member => {
      const person = people.get(id(member.participantId));
      if (!person) fail('Участник состава отсутствует в копии');
      return memberData({ ...person, ...member });
    });
    await db.transaction(async tx => {
      await tx.run('DELETE FROM team_members'); await tx.run('DELETE FROM teams');
      await tx.run('DELETE FROM participants'); await tx.run('DELETE FROM sports');
      for (const sport of definitions) await tx.run('INSERT INTO sports VALUES (?,?,?)', Object.values(sport));
      for (const team of teams) await writeTeam(tx, team);
      for (const person of people.values()) await tx.run('INSERT INTO participants VALUES (?,?,?)', [id(person.id), text(person.firstName ?? '', 'имя', 80), text(person.lastName, 'фамилия', 100, true)]);
      for (const member of members) await writeMember(tx, member);
    });
    await syncSports();
    events.publish('changed', {});
    return { restored: true };
  }));
};
