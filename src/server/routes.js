/**
 * Loopback HTTP routes for the Phase 1 dashboard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReadOnly, close } from '../db/db.js';
import { buildReport } from '../report/report.js';
import { runDoctor, formatDoctorJson } from '../doctor.js';
import { dayKey, nowSec } from '../util/time.js';
import { collapseHome } from '../util/fmt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function hostAllowed(hostHeader, port) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
  return allowed.has(host);
}

function withDb(fn) {
  let db;
  try {
    db = openReadOnly();
  } catch (err) {
    return { error: err, db: null };
  }
  try {
    return { db, value: fn(db), error: null };
  } catch (err) {
    return { db, error: err };
  } finally {
    if (db) close(db);
  }
}

function parseSinceToDays(since) {
  const s = String(since || '1d');
  const m = /^(\d+)([dh])$/.exec(s);
  if (!m) return 1;
  const n = Number(m[1]);
  return m[2] === 'h' ? Math.max(1, Math.ceil(n / 24)) : Math.max(1, n);
}

function apiStatus() {
  const result = withDb((db) => buildReport(db));
  if (result.error && !result.value) {
    return {
      status: 503,
      body: {
        error: 'db_unavailable',
        message: String(result.error.message || result.error),
      },
    };
  }
  return { status: 200, body: result.value };
}

function apiTimeseries(days, top) {
  const d = Math.min(90, Math.max(1, Number(days) || 14));
  const t = Math.min(30, Math.max(1, Number(top) || 8));
  const startDay = dayKey(nowSec() - d * 86400);

  const result = withDb((db) => {
    // Rank paths by latest size among those with recent daily_stats.
    const topPaths = db
      .prepare(
        `SELECT p.id, p.path, p.class,
                (SELECT last_kb FROM daily_stats ds
                 WHERE ds.path_id = p.id
                 ORDER BY ds.day DESC LIMIT 1) AS last_kb
         FROM paths p
         WHERE EXISTS (
           SELECT 1 FROM daily_stats ds WHERE ds.path_id = p.id AND ds.day >= ?
         )
         ORDER BY last_kb DESC
         LIMIT ?`,
      )
      .all(startDay, t);

    const daysList = [];
    for (let i = d - 1; i >= 0; i--) {
      daysList.push(dayKey(nowSec() - i * 86400));
    }

    const series = topPaths.map((p) => {
      const byDay = new Map(
        db
          .prepare(
            `SELECT day, last_kb FROM daily_stats
             WHERE path_id = ? AND day >= ?
             ORDER BY day ASC`,
          )
          .all(p.id, startDay)
          .map((r) => [r.day, r.last_kb]),
      );
      let last = 0;
      const points = daysList.map((day) => {
        if (byDay.has(day)) last = byDay.get(day);
        return { day, size_gb: Math.round((last / (1024 * 1024)) * 100) / 100 };
      });
      return {
        path: collapseHome(p.path) || p.path,
        class: p.class,
        points,
      };
    });

    return { days: daysList, series };
  });

  if (result.error && !result.value) {
    return {
      status: 503,
      body: { error: 'db_unavailable', message: String(result.error.message || result.error) },
    };
  }
  return { status: 200, body: result.value };
}

function apiMovers(since) {
  const days = parseSinceToDays(since);
  const startDay = dayKey(nowSec() - days * 86400);
  const today = dayKey(nowSec());

  const result = withDb((db) => {
    const rows = db
      .prepare(
        `SELECT p.path, p.class, p.kp_id,
                d.last_kb AS size_kb,
                d.delta_kb AS delta_1d_kb,
                (d.last_kb - COALESCE((
                  SELECT d2.last_kb FROM daily_stats d2
                  WHERE d2.path_id = d.path_id AND d2.day <= ?
                  ORDER BY d2.day DESC LIMIT 1
                ), d.last_kb)) AS delta_period_kb
         FROM daily_stats d
         JOIN paths p ON p.id = d.path_id
         WHERE d.day = ?
         ORDER BY ABS(d.delta_kb) DESC
         LIMIT 25`,
      )
      .all(startDay, today);

    return {
      since,
      movers: rows.map((r) => ({
        path: collapseHome(r.path) || r.path,
        class: r.class,
        kp_id: r.kp_id,
        size_gb: Math.round((r.size_kb / (1024 * 1024)) * 100) / 100,
        delta_1d_gb: Math.round((r.delta_1d_kb / (1024 * 1024)) * 100) / 100,
        delta_period_gb:
          Math.round((r.delta_period_kb / (1024 * 1024)) * 100) / 100,
      })),
    };
  });

  if (result.error && !result.value) {
    return {
      status: 503,
      body: { error: 'db_unavailable', message: String(result.error.message || result.error) },
    };
  }
  return { status: 200, body: result.value };
}

function apiEvents(limit) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = withDb((db) => {
    const rows = db
      .prepare(
        `SELECT e.id, e.at, e.kind, e.severity, e.headline, e.detail_json,
                e.open, e.last_seen, e.count, p.path
         FROM events e
         LEFT JOIN paths p ON p.id = e.path_id
         ORDER BY e.at DESC
         LIMIT ?`,
      )
      .all(lim);
    return {
      events: rows.map((e) => {
        let detail = null;
        try {
          detail = e.detail_json ? JSON.parse(e.detail_json) : null;
        } catch {
          detail = e.detail_json;
        }
        return {
          id: e.id,
          at: e.at,
          kind: e.kind,
          severity: e.severity,
          headline: e.headline,
          open: e.open,
          last_seen: e.last_seen,
          count: e.count,
          path: e.path ? collapseHome(e.path) : null,
          detail,
        };
      }),
    };
  });

  if (result.error && !result.value) {
    return {
      status: 503,
      body: { error: 'db_unavailable', message: String(result.error.message || result.error) },
    };
  }
  return { status: 200, body: result.value };
}

function apiDoctor() {
  try {
    const result = runDoctor();
    return { status: 200, body: JSON.parse(formatDoctorJson(result)) };
  } catch (err) {
    return {
      status: 500,
      body: { error: 'doctor_failed', message: String(err.message || err) },
    };
  }
}

function safePublicPath(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0')) return null;
  const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function serveStatic(urlPath) {
  const filePath = safePublicPath(urlPath);
  if (!filePath) return { status: 403, body: 'Forbidden', type: 'text/plain; charset=utf-8' };
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return { status: 404, body: 'Not found', type: 'text/plain; charset=utf-8' };
  }
  const ext = path.extname(filePath);
  const type = MIME[ext] || 'application/octet-stream';
  return { status: 200, body: fs.readFileSync(filePath), type };
}

/**
 * Handle one request. Returns true if handled.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ port: number }} opts
 */
export function handleRequest(req, res, opts) {
  const port = opts.port || 7381;

  if (!hostAllowed(req.headers.host, port)) {
    sendText(res, 403, 'Forbidden host');
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return true;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const pathname = url.pathname;

  if (pathname === '/api/status') {
    const out = apiStatus();
    sendJson(res, out.status, out.body);
    return true;
  }
  if (pathname === '/api/timeseries') {
    const out = apiTimeseries(url.searchParams.get('days'), url.searchParams.get('top'));
    sendJson(res, out.status, out.body);
    return true;
  }
  if (pathname === '/api/movers') {
    const out = apiMovers(url.searchParams.get('since') || '1d');
    sendJson(res, out.status, out.body);
    return true;
  }
  if (pathname === '/api/events') {
    const out = apiEvents(url.searchParams.get('limit'));
    sendJson(res, out.status, out.body);
    return true;
  }
  if (pathname === '/api/doctor') {
    const out = apiDoctor();
    sendJson(res, out.status, out.body);
    return true;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not_found' });
    return true;
  }

  const file = serveStatic(pathname);
  if (req.method === 'HEAD') {
    res.writeHead(file.status, {
      'Content-Type': file.type,
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }
  res.writeHead(file.status, {
    'Content-Type': file.type,
    'Cache-Control': 'no-store',
  });
  res.end(file.body);
  return true;
}

export { PUBLIC_DIR, hostAllowed };
