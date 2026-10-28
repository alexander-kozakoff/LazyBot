// Не печатаем исходные ошибки Discord: они могут содержать запрос и токен.
export function explainError(error) {
  switch (Number(error?.code)) {
    case 10003: return 'Категория или канал удалены. Проверьте DISCORD_CATEGORY_ID и каналы сервера.';
    case 10004: return 'Сервер не найден. Проверьте DISCORD_GUILD_ID и добавление бота на сервер.';
    case 50001: return 'Нет доступа. Проверьте для LazyBot права «Просматривать каналы», «Управлять каналами» и «Подключаться» в выбранной категории и её комнатах.';
    case 50013: return 'Недостаточно прав. Разрешите просмотр, управление каналами и «Подключаться» в выбранной категории.';
    case 30013:
    case 30030: return 'Достигнут лимит каналов Discord. Освободите место на сервере или в категории.';
  }
  if (error?.name === 'ConfigurationError') return error.message;
  return 'Не удалось связаться с Discord. Следующая попытка — не раньше чем через 30 секунд. Проверьте сеть и права бота.';
}

export function createLogger(output = console, now = () => Date.now()) {
  let lastWarning;
  let lastWarningAt = -Infinity;
  return {
    info(message) { output.log(`[LazyBot] ${message}`); },
    warn(message) {
      if (message !== lastWarning || now() - lastWarningAt >= 60_000) {
        output.warn(`[LazyBot] ${message}`);
        lastWarning = message;
        lastWarningAt = now();
      }
    },
  };
}
