// SCHISM — Kalshi live proxy (Netlify Function)
// GET /.netlify/functions/kalshi?tickers=KXBTCMAXY-26DEC31-99999.99,KXINXMAXY-01JAN2027-7999.99
// GET /.netlify/functions/kalshi?event=KXETHY-27JAN0100
//
// Why a proxy: Kalshi's Trade API v2 answers 403 to any request carrying an
// Origin header and sends no CORS headers, so browsers cannot call it
// directly. This function runs server-side (no Origin), so it works.
// It returns PUBLIC market data only — no auth, no keys, no trading.
//
// Modes:
//   tickers=  comma-separated Kalshi market tickers (max 8). Each market is
//             fetched from the single-market endpoint, which is the only
//             endpoint that returns yes bid / yes ask. Response per market:
//             {ticker, title, status, yesBid, yesAsk, yesMid, lastPrice,
//              closeTime} — prices in cents (0-100).
//   event=    one Kalshi event ticker. Returns every market of that event
//             with lastPrice only (the list endpoint carries no bid/ask).
//             Used for range events (KXBTCY / KXETHY) where a threshold
//             probability is the sum of the price-range bands.
//
// Notes:
// - Prices are returned in cents (Kalshi dollars x 100), matching how the
//   SCHISM page displays odds.
// - In-memory cache, 60s TTL per query, so a burst of page refreshes does
//   not hammer Kalshi. Netlify also caches the response for 60s at the edge
//   (Cache-Control header).
// - Never throws a stack to the client; failures are reported per market
//   in `failed` and as a 502 only when nothing could be fetched at all.

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 60 * 1000;
const MAX_TICKERS = 8;

const TICKER_RE = /^[A-Z0-9]+(-[A-Z0-9.]+)+$/;
const EVENT_RE = /^[A-Z0-9]+-[A-Z0-9]+$/;

const cache = new Map(); // key -> { at: number, body: object }

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(body),
  };
}

function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 100; // dollars -> cents, 2 decimals
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Kalshi HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function normaliseMarket(m) {
  const bid = toCents(m.yes_bid_dollars);
  const ask = toCents(m.yes_ask_dollars);
  const last = toCents(m.last_price_dollars);
  const mid =
    bid !== null && ask !== null
      ? Math.round(((bid + ask) / 2) * 100) / 100
      : last;
  return {
    ticker: m.ticker,
    title: m.title || null,
    yesSubTitle: m.yes_sub_title || null,
    status: m.status || null,
    yesBid: bid,
    yesAsk: ask,
    yesMid: mid,
    lastPrice: last,
    closeTime: m.close_time || null,
  };
}

function normaliseBandMarket(m) {
  return {
    ticker: m.ticker,
    title: m.title || null,
    yesSubTitle: m.yes_sub_title || null,
    status: m.status || null,
    yesBid: null,
    yesAsk: null,
    yesMid: null,
    lastPrice: toCents(m.last_price_dollars),
    closeTime: m.close_time || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed. Use GET.' });
  }

  const qs = event.queryStringParameters || {};
  const tickersParam = (qs.tickers || '').trim();
  const eventParam = (qs.event || '').trim().toUpperCase();

  if (!tickersParam && !eventParam) {
    return json(400, {
      error:
        'Pass ?tickers=TICKER1,TICKER2 (max 8, single-market bid/ask) or ?event=EVENT_TICKER (all markets of one event, last price only).',
    });
  }
  if (tickersParam && eventParam) {
    return json(400, { error: 'Pass either ?tickers= or ?event=, not both.' });
  }

  const now = Date.now();
  const cacheKey = tickersParam ? `t:${tickersParam.toUpperCase()}` : `e:${eventParam}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return json(200, { ...hit.body, cached: true });
  }

  try {
    if (tickersParam) {
      const tickers = [
        ...new Set(
          tickersParam
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        ),
      ];
      if (tickers.length === 0 || tickers.length > MAX_TICKERS) {
        return json(400, { error: `Pass 1-${MAX_TICKERS} tickers.` });
      }
      const bad = tickers.find((t) => !TICKER_RE.test(t) || t.length > 80);
      if (bad) return json(400, { error: `Invalid ticker: ${bad}` });

      const settled = await Promise.allSettled(
        tickers.map((t) =>
          fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(t)}`)
        )
      );
      const markets = [];
      const failed = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value && r.value.market) {
          markets.push(normaliseMarket(r.value.market));
        } else {
          failed.push(tickers[i]);
        }
      });
      if (markets.length === 0) {
        return json(502, {
          error: 'Kalshi unreachable or no market returned.',
          failed,
        });
      }
      const body = {
        asOf: new Date().toISOString(),
        source: 'kalshi',
        mode: 'tickers',
        markets,
        failed,
        cached: false,
      };
      cache.set(cacheKey, { at: now, body });
      return json(200, body);
    }

    // event mode
    if (!EVENT_RE.test(eventParam) || eventParam.length > 60) {
      return json(400, { error: `Invalid event ticker: ${eventParam}` });
    }
    const data = await fetchJson(
      `${KALSHI_BASE}/markets?event_ticker=${encodeURIComponent(
        eventParam
      )}&status=open&limit=100`
    );
    const list = Array.isArray(data.markets) ? data.markets : [];
    if (list.length === 0) {
      return json(502, {
        error: `No open markets found for event ${eventParam}.`,
        failed: [eventParam],
      });
    }
    const body = {
      asOf: new Date().toISOString(),
      source: 'kalshi',
      mode: 'event',
      event: eventParam,
      markets: list.map(normaliseBandMarket),
      failed: [],
      cached: false,
    };
    cache.set(cacheKey, { at: now, body });
    return json(200, body);
  } catch (err) {
    return json(502, { error: `Kalshi fetch failed: ${err.message}` });
  }
};
