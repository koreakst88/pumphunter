export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.searchParams.get('path');
    const params = url.searchParams.get('params');

    if (!path) {
      return new Response(JSON.stringify({ error: 'Missing path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const binanceUrl = `https://fapi.binance.com${path}${params ? `?${params}` : ''}`;

    const response = await fetch(binanceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });

    const data = await response.text();

    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
