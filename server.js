/**
 * AstroGame Leaderboard API Server
 * Render.com üzerinde çalışan bağımsız Node.js sunucusu.
 * MySQL (TiDB Cloud) veritabanına doğrudan bağlanır.
 * tRPC batch formatında yanıt verir — mobil app ile uyumlu.
 */

const http = require('http');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;

async function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  const url = new URL(DATABASE_URL);
  const sslParam = url.searchParams.get('ssl');
  let ssl = { rejectUnauthorized: true };
  if (sslParam) {
    try { ssl = JSON.parse(decodeURIComponent(sslParam)); } catch {}
  }
  pool = await mysql.createPool({
    host: url.hostname,
    port: parseInt(url.port) || 4000,
    user: url.username,
    password: url.password,
    database: url.pathname.replace('/', ''),
    ssl,
    connectionLimit: 5,
    connectTimeout: 10000,
  });
  console.log('[DB] Pool created for', url.hostname);
  return pool;
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

async function dbQuery(sql, params = []) {
  const db = await getPool();
  const [rows] = await db.execute(sql, params);
  return rows;
}

function getCurrentWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

async function getUserByOpenId(openId) {
  const rows = await dbQuery('SELECT * FROM users WHERE openId = ? LIMIT 1', [openId]);
  return rows[0] || null;
}

async function upsertDeviceUser(deviceId, username) {
  const openId = `device:${deviceId}`;
  let user = await getUserByOpenId(openId);
  if (user) {
    await dbQuery('UPDATE users SET name = ?, lastSignedIn = NOW() WHERE openId = ?', [username, openId]);
    user = await getUserByOpenId(openId);
  } else {
    await dbQuery(
      'INSERT INTO users (openId, name, loginMethod, lastSignedIn) VALUES (?, ?, ?, NOW())',
      [openId, username, 'device']
    );
    user = await getUserByOpenId(openId);
  }
  if (!user) throw new Error('Failed to create/update device user');
  return user;
}

async function getLeaderboardEntry(userId) {
  const rows = await dbQuery('SELECT * FROM leaderboard WHERE userId = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function upsertLeaderboardEntry(data) {
  const existing = await getLeaderboardEntry(data.userId);
  if (existing) {
    await dbQuery(
      `UPDATE leaderboard SET displayName=?, avatar=?, totalScore=?, gamesPlayed=?, gamesWon=?, level=?, sciencePoints=?, bestWinStreak=? WHERE userId=?`,
      [data.displayName, data.avatar, data.totalScore, data.gamesPlayed, data.gamesWon, data.level, data.sciencePoints, data.bestWinStreak, data.userId]
    );
  } else {
    await dbQuery(
      `INSERT INTO leaderboard (userId, displayName, avatar, totalScore, gamesPlayed, gamesWon, level, sciencePoints, bestWinStreak) VALUES (?,?,?,?,?,?,?,?,?)`,
      [data.userId, data.displayName, data.avatar, data.totalScore, data.gamesPlayed, data.gamesWon, data.level, data.sciencePoints, data.bestWinStreak]
    );
  }
}

async function getTopLeaderboard(limit) {
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  return await dbQuery(`SELECT * FROM leaderboard ORDER BY totalScore DESC LIMIT ${safeLimit}`, []);
}

async function getUserRank(userId) {
  const entry = await getLeaderboardEntry(userId);
  if (!entry) return null;
  const rows = await dbQuery('SELECT COUNT(*) as cnt FROM leaderboard WHERE totalScore > ?', [entry.totalScore]);
  return Number(rows[0]?.cnt || 0) + 1;
}

async function upsertWeeklyScore(data) {
  const weekStart = getCurrentWeekStart();
  const rows = await dbQuery('SELECT id FROM weeklyScores WHERE userId=? AND weekStart=? LIMIT 1', [data.userId, weekStart]);
  if (rows.length > 0) {
    await dbQuery(
      'UPDATE weeklyScores SET displayName=?, avatar=?, weeklyPoints=?, gamesPlayed=?, level=? WHERE userId=? AND weekStart=?',
      [data.displayName, data.avatar, data.weeklyPoints, data.gamesPlayed, data.level, data.userId, weekStart]
    );
  } else {
    await dbQuery(
      'INSERT INTO weeklyScores (userId, weekStart, displayName, avatar, weeklyPoints, gamesPlayed, level) VALUES (?,?,?,?,?,?,?)',
      [data.userId, weekStart, data.displayName, data.avatar, data.weeklyPoints, data.gamesPlayed, data.level]
    );
  }
}

async function getWeeklyLeaderboard(limit) {
  const weekStart = getCurrentWeekStart();
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  return await dbQuery(`SELECT * FROM weeklyScores WHERE weekStart=? ORDER BY weeklyPoints DESC LIMIT ${safeLimit}`, [weekStart]);
}

async function getMyWeeklyRank(userId) {
  const weekStart = getCurrentWeekStart();
  const myRows = await dbQuery('SELECT weeklyPoints FROM weeklyScores WHERE userId=? AND weekStart=? LIMIT 1', [userId, weekStart]);
  if (!myRows[0]) return null;
  const myPoints = myRows[0].weeklyPoints;
  const rows = await dbQuery('SELECT COUNT(*) as cnt FROM weeklyScores WHERE weekStart=? AND weeklyPoints > ?', [weekStart, myPoints]);
  return Number(rows[0]?.cnt || 0) + 1;
}

// ─── tRPC Response Helpers ────────────────────────────────────────────────────

function trpcOk(data) {
  return JSON.stringify([{ result: { data: { json: data } } }]);
}

function trpcError(message) {
  return JSON.stringify([{ error: { message } }]);
}

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-trpc-source');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'astrogame-api', time: new Date().toISOString() }));
    return;
  }

  if (!path.startsWith('/api/trpc/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const procedure = path.replace('/api/trpc/', '');
  res.setHeader('Content-Type', 'application/json');

  try {
    let input = {};
    if (req.method === 'GET') {
      const inputParam = url.searchParams.get('input');
      if (inputParam) {
        const parsed = JSON.parse(decodeURIComponent(inputParam));
        input = parsed?.['0']?.json ?? {};
      }
    } else if (req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}');
      input = parsed?.['0']?.json ?? {};
    }

    let result;

    if (procedure === 'leaderboard.getTop') {
      const limit = Math.min(Number(input.limit) || 100, 200);
      result = await getTopLeaderboard(limit);
    }
    else if (procedure === 'leaderboard.getWeeklyTop') {
      const limit = Math.min(Number(input.limit) || 100, 200);
      result = await getWeeklyLeaderboard(limit);
    }
    else if (procedure === 'leaderboard.getMyRank') {
      const { deviceId } = input;
      if (!deviceId) throw new Error('deviceId required');
      const user = await getUserByOpenId(`device:${deviceId}`);
      if (!user) {
        result = { rank: null, entry: null };
      } else {
        const rank = await getUserRank(user.id);
        const entry = await getLeaderboardEntry(user.id);
        result = { rank, entry: entry || null };
      }
    }
    else if (procedure === 'leaderboard.getMyWeeklyRank') {
      const { deviceId } = input;
      if (!deviceId) throw new Error('deviceId required');
      const user = await getUserByOpenId(`device:${deviceId}`);
      if (!user) {
        result = { rank: null };
      } else {
        const rank = await getMyWeeklyRank(user.id);
        result = { rank };
      }
    }
    else if (procedure === 'leaderboard.updateScore') {
      const { deviceId, displayName, avatar, totalScore, gamesPlayed, gamesWon, level, sciencePoints, bestWinStreak } = input;
      if (!deviceId || !displayName) throw new Error('deviceId and displayName required');
      const user = await upsertDeviceUser(deviceId, displayName);
      await upsertLeaderboardEntry({
        userId: user.id,
        displayName,
        avatar: avatar || '🧑‍🔬',
        totalScore: Number(totalScore) || 0,
        gamesPlayed: Number(gamesPlayed) || 0,
        gamesWon: Number(gamesWon) || 0,
        level: Number(level) || 1,
        sciencePoints: Number(sciencePoints) || 0,
        bestWinStreak: Number(bestWinStreak) || 0,
      });
      result = { success: true, userId: user.id };
    }
    else if (procedure === 'leaderboard.updateWeeklyScore') {
      const { deviceId, displayName, avatar, weeklyPoints, gamesPlayed, level } = input;
      if (!deviceId || !displayName) throw new Error('deviceId and displayName required');
      const user = await upsertDeviceUser(deviceId, displayName);
      await upsertWeeklyScore({
        userId: user.id,
        displayName,
        avatar: avatar || '🧑‍🔬',
        weeklyPoints: Number(weeklyPoints) || 0,
        gamesPlayed: Number(gamesPlayed) || 0,
        level: Number(level) || 1,
      });
      result = { success: true };
    }
    else {
      res.writeHead(404);
      res.end(trpcError(`Unknown procedure: ${procedure}`));
      return;
    }

    res.writeHead(200);
    res.end(trpcOk(result));
  } catch (err) {
    console.error(`[${procedure}] Error:`, err.message);
    res.writeHead(500);
    res.end(trpcError(err.message));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`[AstroGame API] Server running on port ${PORT}`);
  console.log(`[AstroGame API] Database: ${DATABASE_URL ? 'configured ✓' : 'NOT SET ✗'}`);
  getPool()
    .then(() => console.log('[DB] Connection pool ready ✓'))
    .catch(e => console.error('[DB] Connection failed:', e.message));
});
