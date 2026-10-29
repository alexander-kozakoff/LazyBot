import { escapeMarkdown } from 'discord.js';

export const TEMPLATE_VARIABLES = ['member', 'server', 'inviter', 'source', 'count'];

export function validateWelcome(template) {
  if (!template.trim() || template.length > 1200) {
    throw new Error('Текст приветствия должен содержать от 1 до 1200 символов.');
  }
  const unknown = [...template.matchAll(/\{([^{}]+)\}/g)].find(match => !TEMPLATE_VARIABLES.includes(match[1]));
  if (unknown) throw new Error('Неизвестная переменная. Доступны: {member}, {server}, {inviter}, {source}, {count}.');
  return template;
}

export function sourceText(event) {
  if (event.source === 'bot') return 'добавление бота';
  if (event.source === 'vanity') return event.label ?? 'общая ссылка сервера';
  if (event.source !== 'invite') return 'источник неизвестен';
  return event.label ?? event.code ?? 'приглашение';
}

export function renderWelcome(template, member, event) {
  const values = {
    member: '<@' + member.id + '>',
    server: escapeMarkdown(member.guild.name),
    inviter: event.inviterId ? '<@' + event.inviterId + '>' : 'неизвестно',
    source: escapeMarkdown(sourceText(event)),
    count: String(member.guild.memberCount),
  };
  // Один проход: имена сервера и метки не интерпретируются как новый шаблон.
  return template.replace(/\{(member|server|inviter|source|count)\}/g, (_, key) => values[key]).slice(0, 2000);
}

export function renderEvent(event) {
  const source = escapeMarkdown(sourceText(event));
  const inviter = event.inviterId ? ' · Пригласил: <@' + event.inviterId + '>' : '';
  const flags = [event.rejoin ? 'повторный вход' : '', event.young ? 'аккаунту меньше 7 дней (без штрафа)' : '']
    .filter(Boolean).join(' · ');
  return (event.type === 'join' ? 'Вошёл ' : 'Вышел ') + '<@' + event.userId + '>'
    + ' · <t:' + Math.floor(event.at / 1000) + ':f> · ' + source + inviter + (flags ? ' · ' + flags : '');
}
