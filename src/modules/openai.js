const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const ANALYSIS_UNAVAILABLE_MESSAGE = '⚠️ Анализ временно недоступен, попробуйте позже';

const SYSTEM_PROMPT = `
Ты опытный криптотрейдер-аналитик специализирующийся на скальпинге волатильных альткоинов.

Твоя задача: проанализировать открытую позицию трейдера на основе текущих рыночных данных и дать одну из трёх рекомендаций:

ВЫХОД 🚨 — данные против позиции, нужно зафиксировать убыток пока он небольшой. Используй когда: объём и OI продолжают расти (для шорта), памп не показывает признаков истощения, funding не подтверждает разворот.

ДЕРЖИ ⏳ — признаки разворота появляются, можно держать позицию со стопом. Используй когда: объём начинает падать, OI стабилизируется, но разворот ещё не подтверждён полностью.

УСРЕДНЯЙ ✅ — все признаки истощения совпали, можно добавить к позиции по плану. Используй когда: объём явно падает, OI снижается, funding перегрет (для шорта), свечи уменьшаются.

Формат ответа:
1. Рекомендация (одно слово: ВЫХОД/ДЕРЖИ/УСРЕДНЯЙ)
2. Краткое обоснование (3-5 предложений)
3. Конкретный уровень стоп-лосса
4. Если УСРЕДНЯЙ — на каком уровне и каким объёмом

Будь конкретным, не лей воду. Трейдер принимает решение за секунды.
`.trim();

function buildUserPrompt(positionData, marketData) {
  return `
Проанализируй позицию:

Символ: ${positionData.symbol}
Направление: ${positionData.type} (SHORT/LONG)
Цена входа: $${positionData.entryPrice}
Текущая цена: $${positionData.currentPrice}
P&L: ${positionData.pnlPercent}%

Текущие рыночные данные:
- Изменение цены за 1ч: ${marketData.change1h}%
- Объём 24ч: $${marketData.volume24h}
- Тренд объёма свечей: ${marketData.volumeTrend} (растёт/падает/стабильно)
- Open Interest изменение за 1ч: ${marketData.oiChange}%
- OI тренд: ${marketData.oiTrend}
- Funding Rate: ${marketData.fundingRate}%

Дай рекомендацию.
`.trim();
}

function parseRecommendation(content) {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) || '';
  const match = firstLine.match(/(ВЫХОД|ДЕРЖИ|УСРЕДНЯЙ)/i)
    || content.match(/(ВЫХОД|ДЕРЖИ|УСРЕДНЯЙ)/i);

  return match ? match[1].toUpperCase() : 'НЕОПРЕДЕЛЕНО';
}

async function analyzePosition(positionData, marketData) {
  if (!config.OPENAI_API_KEY) {
    logger.error('OpenAI API key is missing');
    return {
      recommendation: 'НЕДОСТУПНО',
      content: ANALYSIS_UNAVAILABLE_MESSAGE,
    };
  }

  const userPrompt = buildUserPrompt(positionData, marketData);

  logger.info(`OpenAI analyzePosition request: ${positionData.symbol} ${positionData.type}, pnl=${positionData.pnlPercent}%`);

  try {
    const response = await axios.post(
      OPENAI_CHAT_COMPLETIONS_URL,
      {
        model: MODEL,
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error('OpenAI returned empty content');
    }

    const recommendation = parseRecommendation(content);
    logger.info(`OpenAI analyzePosition response: ${positionData.symbol} recommendation=${recommendation}; content=${content}`);

    return {
      recommendation,
      content,
    };
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message;
    logger.error(`OpenAI analyzePosition failed: ${message}`);

    return {
      recommendation: 'НЕДОСТУПНО',
      content: ANALYSIS_UNAVAILABLE_MESSAGE,
    };
  }
}

module.exports = {
  analyzePosition,
};
