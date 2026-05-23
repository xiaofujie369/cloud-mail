import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const PORT = toInt(env.PORT, 8080);
const DATA_DIR = env.SMTP_DATA_DIR || '/data';
const STORE_PATH = path.join(DATA_DIR, 'messages.jsonl');
const API_TOKEN = env.SMTP_API_TOKEN || '';
const MAX_BODY_BYTES = toInt(env.SMTP_MAX_BODY_BYTES, 1024 * 1024);
const MAX_RECIPIENTS = toInt(env.SMTP_MAX_RECIPIENTS, 50);
const RATE_LIMIT_WINDOW_MS = toInt(env.SMTP_RATE_LIMIT_WINDOW_MS, 60_000);
const RATE_LIMIT_MAX = toInt(env.SMTP_RATE_LIMIT_MAX, 60);
const ALLOWED_ORIGINS = parseList(env.SMTP_API_ALLOWED_ORIGINS || '');

if (API_TOKEN.length < 24 || API_TOKEN === 'change-me') {
  console.error('SMTP_API_TOKEN must be set to a strong random value with at least 24 characters.');
  process.exit(1);
}

await fs.mkdir(DATA_DIR, { recursive: true });

const rateBuckets = new Map();

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'cloud-mail-smtp-api' });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (!checkRateLimit(req)) {
      sendJson(res, 429, { error: 'rate_limit_exceeded' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const payload = await readJson(req);
      const result = await handleSend(payload, req);
      sendJson(res, 202, result);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/stats') {
      const days = clamp(toInt(url.searchParams.get('days'), 14), 1, 90);
      const stats = await getStats(days);
      sendJson(res, 200, stats);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/messages') {
      const result = await listMessages(url.searchParams);
      sendJson(res, 200, result);
      return;
    }

    const messageMatch = url.pathname.match(/^\/admin\/messages\/([a-f0-9-]+)$/i);
    if (req.method === 'GET' && messageMatch) {
      const record = await getMessage(messageMatch[1]);
      if (!record) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, record);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: error.message
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`cloud-mail smtp-api listening on 0.0.0.0:${PORT}`);
});

async function handleSend(payload, req) {
  const startedAt = Date.now();
  const mail = normalizeMail(payload);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const baseRecord = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    from: mail.from.address,
    fromName: mail.from.name,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    remoteAddress: clientIp(req),
    smtpHost: env.SMTP_HOST,
    attempts: 1
  };

  await appendRecord(baseRecord);

  try {
    const sent = await sendSmtp(mail);
    const record = {
      ...baseRecord,
      updatedAt: new Date().toISOString(),
      status: 'sent',
      providerMessageId: sent.messageId,
      smtpResponse: sent.response,
      durationMs: Date.now() - startedAt
    };
    await appendRecord(record);
    return {
      id,
      status: record.status,
      messageId: sent.messageId,
      response: sent.response
    };
  } catch (error) {
    const record = {
      ...baseRecord,
      updatedAt: new Date().toISOString(),
      status: 'failed',
      error: error.message,
      durationMs: Date.now() - startedAt
    };
    await appendRecord(record);
    error.statusCode = 502;
    throw error;
  }
}

function normalizeMail(payload) {
  if (!payload || typeof payload !== 'object') {
    throw httpError(400, 'JSON body is required.');
  }

  const fromAddress = sanitizeEmail(payload.from || env.SMTP_FROM);
  if (!fromAddress) {
    throw httpError(400, 'A valid from address is required. Set SMTP_FROM or pass from.');
  }

  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const recipients = [...to, ...cc, ...bcc];

  if (to.length === 0) {
    throw httpError(400, 'At least one to recipient is required.');
  }

  if (recipients.length > MAX_RECIPIENTS) {
    throw httpError(400, `Too many recipients. Max is ${MAX_RECIPIENTS}.`);
  }

  const subject = sanitizeHeader(payload.subject || '(no subject)', 250);
  const text = typeof payload.text === 'string' ? payload.text : '';
  const html = typeof payload.html === 'string' ? payload.html : '';

  if (!text && !html) {
    throw httpError(400, 'Either text or html content is required.');
  }

  return {
    from: {
      address: fromAddress,
      name: sanitizeHeader(payload.fromName || env.SMTP_FROM_NAME || '', 120)
    },
    replyTo: sanitizeEmail(payload.replyTo || ''),
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    headers: sanitizeCustomHeaders(payload.headers || {})
  };
}

async function sendSmtp(mail) {
  const host = env.SMTP_HOST;
  const port = toInt(env.SMTP_PORT, 587);

  if (!host) {
    throw new Error('SMTP_HOST is not configured.');
  }

  const secure = toBool(env.SMTP_SECURE) || port === 465;
  const starttls = env.SMTP_STARTTLS ? toBool(env.SMTP_STARTTLS) : !secure;
  const rejectUnauthorized = env.SMTP_REJECT_UNAUTHORIZED ? toBool(env.SMTP_REJECT_UNAUTHORIZED) : true;
  const timeoutMs = toInt(env.SMTP_TIMEOUT_MS, 30_000);
  const hostname = env.SMTP_EHLO_HOST || 'cloud-mail.local';
  const envelopeFrom = mail.from.address;
  const recipients = [...mail.to, ...mail.cc, ...mail.bcc];
  const messageId = `<${crypto.randomUUID()}@${hostname}>`;
  const mime = buildMime(mail, messageId);

  let socket = await connectSocket({ host, port, secure, rejectUnauthorized, timeoutMs });
  let conn = createSmtpConnection(socket, timeoutMs);

  try {
    await conn.expect([220]);
    await conn.command(`EHLO ${hostname}`, [250]);

    if (starttls && !secure) {
      await conn.command('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket = await upgradeTls(socket, host, rejectUnauthorized, timeoutMs);
      conn = createSmtpConnection(socket, timeoutMs);
      await conn.command(`EHLO ${hostname}`, [250]);
    }

    if (env.SMTP_USER || env.SMTP_PASS) {
      await authLogin(conn, env.SMTP_USER || '', env.SMTP_PASS || '');
    }

    await conn.command(`MAIL FROM:<${envelopeFrom}>`, [250]);
    for (const recipient of recipients) {
      await conn.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await conn.command('DATA', [354]);
    const response = await conn.writeData(`${escapeDotLines(mime)}\r\n.`);
    assertCode(response, [250]);
    await conn.command('QUIT', [221]).catch(() => null);

    return {
      messageId,
      response: response.lines.join(' ')
    };
  } finally {
    socket.end();
    socket.destroySoon?.();
  }
}

function connectSocket({ host, port, secure, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP connection timeout.'));
    }, timeoutMs);

    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function upgradeTls(socket, host, rejectUnauthorized, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error('SMTP STARTTLS timeout.'));
    }, timeoutMs);

    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function createSmtpConnection(socket, timeoutMs) {
  let buffer = '';
  const waiters = [];

  socket.setTimeout(timeoutMs);
  socket.on('timeout', () => socket.destroy(new Error('SMTP socket timeout.')));
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    flush();
  });
  socket.on('error', error => {
    while (waiters.length) {
      waiters.shift().reject(error);
    }
  });
  socket.on('close', () => {
    while (waiters.length) {
      waiters.shift().reject(new Error('SMTP connection closed.'));
    }
  });

  function flush() {
    const lastLineMatch = buffer.match(/(?:^|\r?\n)(\d{3}) (.*)\r?\n$/);
    if (!lastLineMatch || waiters.length === 0) return;

    const raw = buffer;
    buffer = '';
    const lines = raw.trimEnd().split(/\r?\n/);
    const code = Number(lastLineMatch[1]);
    waiters.shift().resolve({ code, lines });
  }

  function readResponse() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      flush();
    });
  }

  return {
    async expect(codes) {
      const response = await readResponse();
      assertCode(response, codes);
      return response;
    },
    async command(command, codes) {
      socket.write(`${command}\r\n`);
      const response = await readResponse();
      assertCode(response, codes);
      return response;
    },
    async writeData(data) {
      socket.write(`${data}\r\n`);
      return readResponse();
    }
  };
}

async function authLogin(conn, user, pass) {
  try {
    const token = Buffer.from(`\0${user}\0${pass}`).toString('base64');
    await conn.command(`AUTH PLAIN ${token}`, [235]);
    return;
  } catch {
    await conn.command('AUTH LOGIN', [334]);
    await conn.command(Buffer.from(user).toString('base64'), [334]);
    await conn.command(Buffer.from(pass).toString('base64'), [235]);
  }
}

function buildMime(mail, messageId) {
  const headers = [
    ['Date', new Date().toUTCString()],
    ['From', formatMailbox(mail.from)],
    ['To', mail.to.join(', ')],
    mail.cc.length ? ['Cc', mail.cc.join(', ')] : null,
    mail.replyTo ? ['Reply-To', mail.replyTo] : null,
    ['Subject', encodeHeader(mail.subject)],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0']
  ].filter(Boolean);

  for (const [key, value] of Object.entries(mail.headers)) {
    headers.push([key, value]);
  }

  if (mail.text && mail.html) {
    const boundary = `cm-alt-${crypto.randomBytes(12).toString('hex')}`;
    return [
      ...headers.map(([key, value]) => `${key}: ${value}`),
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeNewlines(mail.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeNewlines(mail.html),
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }

  const contentType = mail.html ? 'text/html' : 'text/plain';
  const body = mail.html || mail.text;
  return [
    ...headers.map(([key, value]) => `${key}: ${value}`),
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeNewlines(body),
    ''
  ].join('\r\n');
}

function formatMailbox(mailbox) {
  if (!mailbox.name) return mailbox.address;
  return `${encodeHeader(mailbox.name)} <${mailbox.address}>`;
}

function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function normalizeNewlines(value) {
  return String(value).replace(/\r?\n/g, '\r\n');
}

function escapeDotLines(value) {
  return value.replace(/^\./gm, '..');
}

function assertCode(response, codes) {
  if (!codes.includes(response.code)) {
    throw new Error(`Unexpected SMTP response ${response.code}: ${response.lines.join(' ')}`);
  }
}

async function appendRecord(record) {
  await fs.appendFile(STORE_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function readRecords() {
  try {
    const content = await fs.readFile(STORE_PATH, 'utf8');
    const latest = new Map();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      latest.set(record.id, record);
    }
    return [...latest.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listMessages(params) {
  const page = clamp(toInt(params.get('page'), 1), 1, 10_000);
  const pageSize = clamp(toInt(params.get('pageSize'), 20), 1, 100);
  const status = (params.get('status') || '').trim().toLowerCase();
  const q = (params.get('q') || '').trim().toLowerCase();
  const records = await readRecords();
  const filtered = records.filter(record => {
    if (status && record.status !== status) return false;
    if (!q) return true;
    return [
      record.id,
      record.from,
      ...(record.to || []),
      ...(record.cc || []),
      record.subject,
      record.error
    ].filter(Boolean).some(value => String(value).toLowerCase().includes(q));
  });
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total: filtered.length,
    list: filtered.slice(start, start + pageSize)
  };
}

async function getMessage(id) {
  const records = await readRecords();
  return records.find(record => record.id === id) || null;
}

async function getStats(days) {
  const records = await readRecords();
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const byStatus = {};
  const byDayMap = new Map();
  const recentCutoff = now - days * 24 * 60 * 60 * 1000;

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    byDayMap.set(date, { date, total: 0, sent: 0, failed: 0, queued: 0 });
  }

  for (const record of records) {
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    const created = Date.parse(record.createdAt);
    const date = record.createdAt?.slice(0, 10);
    if (created >= recentCutoff && byDayMap.has(date)) {
      const day = byDayMap.get(date);
      day.total += 1;
      day[record.status] = (day[record.status] || 0) + 1;
    }
  }

  return {
    total: records.length,
    sent: byStatus.sent || 0,
    failed: byStatus.failed || 0,
    queued: byStatus.queued || 0,
    today: records.filter(record => record.createdAt?.startsWith(today)).length,
    last24h: records.filter(record => Date.parse(record.createdAt) >= now - 24 * 60 * 60 * 1000).length,
    byStatus,
    byDay: [...byDayMap.values()],
    recent: records.slice(0, 10)
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON body.');
  }
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return safeEqual(token, API_TOKEN);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function checkRateLimit(req) {
  const key = `${clientIp(req)}:${Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS)}`;
  const count = rateBuckets.get(key) || 0;
  rateBuckets.set(key, count + 1);

  if (rateBuckets.size > 5000) {
    const currentWindow = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
    for (const bucket of rateBuckets.keys()) {
      if (!bucket.endsWith(`:${currentWindow}`)) rateBuckets.delete(bucket);
    }
  }

  return count < RATE_LIMIT_MAX;
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.length === 0) return false;
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sanitizeCustomHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return result;
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    const clean = sanitizeHeader(String(value), 500);
    if (clean) result[key] = clean;
  }
  return result;
}

function sanitizeHeader(value, maxLength) {
  return String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function normalizeAddressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map(item => sanitizeEmail(item)).filter(Boolean))];
}

function sanitizeEmail(value) {
  const email = String(value || '').trim().replace(/^.*<(.+)>$/, '$1');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return '';
  if (/[\r\n]/.test(email)) return '';
  return email;
}

function parseList(value) {
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
