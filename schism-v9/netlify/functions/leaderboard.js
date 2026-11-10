// SCHISM — Call the Close global leaderboard (Netlify Function)
// GET  /.netlify/functions/leaderboard           -> top 10 + totals
// GET  /.netlify/functions/leaderboard?name=X    -> top 10 + totals + your entry/rank
// POST /.netlify/functions/leaderboard           {name, won, eventId}
//
// Storage: Netlify Blobs, one JSON document (store `schism-leaderboard`,
// key `board.json`). No extra account, no keys to manage; the store is
// created on first use. Data is tiny (a few KB).
//
// Ranking: accuracy = wins / calls. A player needs >= 3 resolved calls to
// appear in the top 10. Ties break by more calls, then by name.
// This is a community fun board, not money: names are self-chosen, there is
// no login, and it is not Sybil-proof. Validation below only keeps the
// board clean (name shape, sane sizes, one submit per name per 30s).
//
// Honest limits (kept in code on purpose):
// - Read-modify-write on one document: two simultaneous POSTs can
//   overwrite each other and lose one result. Traffic here is far below
//   the level where that matters; if the board ever gets busy, move the
//   counters to one Blobs key per player.
// - The 30s per-name throttle is in-memory only: it resets on a cold
//   start, so it is best-effort, not a guarantee.

const { getStore, connectLambda } = require('@netlify/blobs');

const STORE_NAME = 'schism-leaderboard';
const BOARD_KEY = 'board.json';
const MIN_CALLS_TO_RANK = 3;
const TOP_N = 10;
const MAX_PLAYERS = 500;
const MAX_CALLS_PER_PLAYER = 100000;
const SUBMIT_GAP_MS = 30 * 1000;

const lastSubmit = new Map(); // name -> timestamp (best-effort throttle)

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) return null;
  if (!/^[A-Za-z0-9 ._\-]+$/.test(name)) return null;
  return name;
}

function rankBoard(players) {
  const entries = Object.entries(players).map(([name, p]) => ({
    name,
    wins: p.wins,
    calls: p.calls,
    acc:
      p.calls > 0 ? Math.round((p.wins / p.calls) * 1000) / 10 : 0,
  }));
  const ranked = entries
    .filter((e) => e.calls >= MIN_CALLS_TO_RANK)
    .sort((a, b) => b.acc - a.acc || b.calls - a.calls || a.name.localeCompare(b.name));
  const totals = {
    players: entries.length,
    calls: entries.reduce((s, e) => s + e.calls, 0),
  };
  return { ranked, totals };
}

async function loadBoard() {
  const store = getStore(STORE_NAME);
  const board = await store.get(BOARD_KEY, { type: 'json' });
  if (board && typeof board === 'object' && board.players) return board;
  return { players: {} };
}

async function saveBoard(board) {
  const store = getStore(STORE_NAME);
  await store.setJSON(BOARD_KEY, board);
}

exports.handler = async (event) => {
  try {
    // V1 Lambda-style function: Netlify does NOT inject the Blobs context
    // automatically here (that only happens for V2 functions), so load the
    // credentials Netlify provides for this invocation first. Without this
    // call getStore() throws "environment has not been configured to use
    // Netlify Blobs" in production.
    connectLambda(event);
    if (event.httpMethod === 'GET') {
      const board = await loadBoard();
      const { ranked, totals } = rankBoard(board.players);
      const out = { board: ranked.slice(0, TOP_N), totals };
      const name = cleanName((event.queryStringParameters || {}).name || '');
      if (name) {
        const p = board.players[name];
        const idx = ranked.findIndex((e) => e.name === name);
        out.you = p
          ? {
              name,
              wins: p.wins,
              calls: p.calls,
              acc: p.calls > 0 ? Math.round((p.wins / p.calls) * 1000) / 10 : 0,
              rank: idx >= 0 ? idx + 1 : null,
            }
          : null;
      }
      return json(200, out);
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return json(400, { error: 'Body must be valid JSON.' });
      }
      const name = cleanName(body.name);
      if (!name) {
        return json(400, {
          error: 'name must be 1-24 characters: letters, digits, space, . _ -',
        });
      }
      if (typeof body.won !== 'boolean') {
        return json(400, { error: 'won must be true or false.' });
      }
      if (
        body.eventId !== undefined &&
        (typeof body.eventId !== 'string' || body.eventId.length > 64)
      ) {
        return json(400, { error: 'eventId must be a string up to 64 chars.' });
      }

      const now = Date.now();
      const last = lastSubmit.get(name) || 0;
      if (now - last < SUBMIT_GAP_MS) {
        return json(429, {
          error: 'Too fast — one result per name every 30 seconds.',
        });
      }

      const board = await loadBoard();
      const isNew = !board.players[name];
      if (isNew && Object.keys(board.players).length >= MAX_PLAYERS) {
        return json(429, { error: 'Leaderboard is full.' });
      }
      const p = board.players[name] || { wins: 0, calls: 0 };
      if (p.calls >= MAX_CALLS_PER_PLAYER) {
        return json(429, { error: 'Call limit reached for this name.' });
      }
      p.calls += 1;
      if (body.won) p.wins += 1;
      p.updatedAt = new Date().toISOString();
      board.players[name] = p;
      await saveBoard(board);
      lastSubmit.set(name, now);

      const { ranked, totals } = rankBoard(board.players);
      const idx = ranked.findIndex((e) => e.name === name);
      return json(200, {
        you: {
          name,
          wins: p.wins,
          calls: p.calls,
          acc: Math.round((p.wins / p.calls) * 1000) / 10,
          rank: idx >= 0 ? idx + 1 : null,
        },
        totals,
      });
    }

    return json(405, { error: 'Method not allowed. Use GET or POST.' });
  } catch (err) {
    return json(500, { error: `Leaderboard error: ${err.message}` });
  }
};
