# PumpHunter

Telegram-бот для скальпинга волатильных криптовалют. Автоматически сканирует рынок Binance Futures, находит экстремальные движения и отправляет торговые сигналы с рекомендованными уровнями входа.

## Возможности

- Автоматическое сканирование топ-500 монет каждые 5 минут
- ШОРТ сигналы на пампах +50%+ с признаками истощения
- ЛОНГ сигналы на начинающихся движениях +15-25%
- Рейтинг качества сигнала (⭐-⭐⭐⭐)
- Анализ открытых позиций через AI (OpenAI GPT-4o-mini)
- Трекинг позиций и P&L
- Дневной лимит убытков
- Тихий ночной режим

## Установка

1. Клонировать репо
2. Установить зависимости:

```bash
npm install
```

3. Скопировать `.env.example` в `.env` и заполнить ключи
4. Запустить:

```bash
npm start
```

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` — токен бота от @BotFather
- `TELEGRAM_CHAT_ID` — ID чата для сигналов
- `OPENAI_API_KEY` — ключ OpenAI API

## Команды бота

- `/start` — приветствие и статус бота
- `/help` — список доступных команд
- `/scan SYMBOL` — ручной скан монеты, пример: `/scan BTCUSDT`
- `/analyze SYMBOL TYPE ENTRY_PRICE` — анализ открытой позиции через OpenAI, пример: `/analyze XYZUSDT short 0.084`
- `/enter SYMBOL TYPE PRICE [SIZE]` — зарегистрировать вход в позицию, пример: `/enter XYZUSDT short 0.084 25`
- `/close SYMBOL [PRICE]` — закрыть позицию; если цена не указана, берётся текущая цена Binance Futures
- `/positions` — список открытых позиций с текущим P&L
- `/stats` или `/stats today` — статистика за сегодня
- `/stats week` — статистика за последние 7 дней
- `/settings` — текущие настройки депозита, дневного лимита и тихих часов

## Деплой на Railway

1. Push на GitHub
2. Создать проект на Railway
3. Подключить репо
4. Добавить environment variables
5. Deploy

Railway использует `Procfile`:

```Procfile
worker: node src/index.js
```

## Технологии

Node.js, Telegraf, Binance Futures API, OpenAI API, SQLite (sql.js)
