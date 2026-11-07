const crypto = require('crypto');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dojo-ims-dev-secret-please-change';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 小时
const COOKIE_NAME = 'dojo_sid';

// ---------- 会话 ----------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function issueToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      uid: user.id,
      username: user.username,
      role: user.role,
      name: user.display_name,
      exp: Date.now() + SESSION_TTL_MS
    })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function parseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function getSession(req) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return parseToken(decodeURIComponent(match[1]));
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- 工具 ----------

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return '﻿' + lines.join('\r\n');
}

const TYPE_LABELS = { borrow: '借用', return: '归还', repair: '报修', check: '点检' };
const STATUS_LABELS = { pending: '待审批', approved: '已完成', rejected: '已驳回' };

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 路由 ----------

const routes = [];

function route(method, pattern, opts, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, opts, handler });
}

// 认证
route('POST', '/api/login', { auth: false }, async (req, res, url, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) throw badRequest('请输入用户名和密码');
  const rows = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
    return json(res, 401, { ok: false, error: '用户名或密码错误' });
  }
  setSessionCookie(res, issueToken(user));
  json(res, 200, {
    ok: true,
    user: { username: user.username, role: user.role, name: user.display_name }
  });
});

route('POST', '/api/logout', { auth: false }, async (req, res) => {
  clearSessionCookie(res);
  json(res, 200, { ok: true });
});

route('GET', '/api/me', { auth: true }, async (req, res, url, body, session) => {
  json(res, 200, { ok: true, user: { username: session.username, role: session.role, name: session.name } });
});

// 物品台账
route('GET', '/api/items', { auth: true }, async (req, res) => {
  const rows = await db.query('SELECT * FROM items ORDER BY area, name, id');
  json(res, 200, { ok: true, items: rows });
});

route('POST', '/api/items', { auth: true, admin: true }, async (req, res, url, body) => {
  const area = String(body.area || '').trim();
  const name = String(body.name || '').trim();
  const subName = String(body.sub_name || '').trim();
  const brand = String(body.brand || '').trim();
  const quantity = Number(body.quantity);
  if (!area || !name) throw badRequest('区域和名称必填');
  if (!Number.isInteger(quantity) || quantity < 0) throw badRequest('数量必须是非负整数');
  const id = await db.insert(
    'INSERT INTO items (area, name, sub_name, brand, quantity, borrowed, status, created_at) VALUES ($1,$2,$3,$4,$5,0,$6,$7)',
    [area, name, subName, brand, quantity, '可用', db.now()]
  );
  json(res, 200, { ok: true, id });
});

route('PUT', '/api/items/:id', { auth: true, admin: true }, async (req, res, url, body) => {
  const id = Number(req.params.id);
  const rows = await db.query('SELECT * FROM items WHERE id = $1', [id]);
  if (!rows[0]) return json(res, 404, { ok: false, error: '物品不存在' });
  const area = String(body.area || '').trim();
  const name = String(body.name || '').trim();
  const subName = String(body.sub_name || '').trim();
  const brand = String(body.brand || '').trim();
  const quantity = Number(body.quantity);
  const status = String(body.status || '').trim();
  if (!area || !name) throw badRequest('区域和名称必填');
  if (!Number.isInteger(quantity) || quantity < 0) throw badRequest('数量必须是非负整数');
  if (!['可用', '可疑', '报废'].includes(status)) throw badRequest('状态必须是 可用/可疑/报废');
  await db.run(
    'UPDATE items SET area=$1, name=$2, sub_name=$3, brand=$4, quantity=$5, status=$6 WHERE id=$7',
    [area, name, subName, brand, quantity, status, id]
  );
  json(res, 200, { ok: true });
});

route('DELETE', '/api/items/:id', { auth: true, admin: true }, async (req, res) => {
  const id = Number(req.params.id);
  const pending = await db.query(
    "SELECT COUNT(*) AS c FROM requests WHERE item_id = $1 AND status = 'pending'",
    [id]
  );
  if (Number(pending[0].c) > 0) {
    return json(res, 409, { ok: false, error: '该物品存在待审批申请，不能删除' });
  }
  await db.run('DELETE FROM items WHERE id = $1', [id]);
  json(res, 200, { ok: true });
});

// 申请
route('GET', '/api/requests', { auth: true }, async (req, res, url, body, session) => {
  let rows;
  if (session.role === 'admin') {
    rows = await db.query(
      `SELECT r.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area
       FROM requests r JOIN items i ON i.id = r.item_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC`
    );
  } else {
    rows = await db.query(
      `SELECT r.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area
       FROM requests r JOIN items i ON i.id = r.item_id
       WHERE r.created_by = $1
       ORDER BY r.id DESC`,
      [session.username]
    );
  }
  json(res, 200, { ok: true, requests: rows });
});

route('POST', '/api/requests', { auth: true }, async (req, res, url, body, session) => {
  const type = String(body.type || '');
  const itemId = Number(body.item_id);
  const quantity = Number(body.quantity);
  const note = String(body.note || '').trim();
  if (!TYPE_LABELS[type]) throw badRequest('申请类型无效');
  const itemRows = await db.query('SELECT * FROM items WHERE id = $1', [itemId]);
  const item = itemRows[0];
  if (!item) throw badRequest('物品不存在');
  if (!Number.isInteger(quantity) || quantity <= 0) throw badRequest('数量必须是正整数');
  if (type === 'borrow') {
    const available = item.quantity - item.borrowed;
    if (quantity > available) throw badRequest(`可借数量不足（当前可借 ${available}）`);
    if (item.status === '报废') throw badRequest('该物品已报废，不能借用');
  }
  if (note.length > 200) throw badRequest('事由不能超过 200 字');
  const id = await db.insert(
    'INSERT INTO requests (type, item_id, quantity, note, status, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [type, itemId, quantity, note, 'pending', session.username, db.now()]
  );
  json(res, 200, { ok: true, id });
});

route('POST', '/api/requests/:id/review', { auth: true, admin: true }, async (req, res, url, body, session) => {
  const id = Number(req.params.id);
  const action = String(body.action || '');
  const reviewNote = String(body.note || '').trim();
  if (!['approve', 'reject'].includes(action)) throw badRequest('操作无效');
  const rows = await db.query('SELECT * FROM requests WHERE id = $1', [id]);
  const request = rows[0];
  if (!request) return json(res, 404, { ok: false, error: '申请不存在' });
  if (request.status !== 'pending') {
    return json(res, 409, { ok: false, error: '该申请已处理，请刷新页面' });
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  if (action === 'approve' && request.type === 'borrow') {
    const itemRows = await db.query('SELECT * FROM items WHERE id = $1', [request.item_id]);
    const item = itemRows[0];
    if (!item) return json(res, 409, { ok: false, error: '物品已被删除，无法批准借用' });
    const available = item.quantity - item.borrowed;
    if (request.quantity > available) {
      return json(res, 409, { ok: false, error: `可借数量不足（当前可借 ${available}），无法批准` });
    }
    await db.run('UPDATE items SET borrowed = borrowed + $1 WHERE id = $2', [request.quantity, request.item_id]);
  }
  if (action === 'approve' && request.type === 'return') {
    await db.run(
      'UPDATE items SET borrowed = CASE WHEN borrowed - $1 < 0 THEN 0 ELSE borrowed - $1 END WHERE id = $2',
      [
      request.quantity,
      request.item_id
    ]);
  }

  await db.run(
    'UPDATE requests SET status=$1, reviewed_by=$2, reviewed_at=$3, review_note=$4 WHERE id=$5',
    [newStatus, session.username, db.now(), reviewNote, id]
  );
  json(res, 200, { ok: true });
});

// 导出
route('GET', '/api/export/items', { auth: true, admin: true }, async (req, res) => {
  const rows = await db.query('SELECT * FROM items ORDER BY area, name, id');
  const csv = toCsv(
    ['区域', '名称', '细分', '品牌', '总数', '已借出', '可借', '状态'],
    rows.map((r) => [r.area, r.name, r.sub_name, r.brand, r.quantity, r.borrowed, r.quantity - r.borrowed, r.status])
  );
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="items.csv"'
  });
  res.end(csv);
});

route('GET', '/api/export/requests', { auth: true, admin: true }, async (req, res) => {
  const rows = await db.query(
    `SELECT r.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area
     FROM requests r JOIN items i ON i.id = r.item_id ORDER BY r.id`
  );
  const csv = toCsv(
    ['单号', '类型', '区域', '物品名称', '细分', '数量', '事由', '申请人', '申请时间', '状态', '审批人', '审批时间', '审批意见'],
    rows.map((r) => [
      r.id,
      TYPE_LABELS[r.type] || r.type,
      r.item_area,
      r.item_name,
      r.item_sub_name,
      r.quantity,
      r.note,
      r.created_by,
      formatTime(r.created_at),
      STATUS_LABELS[r.status] || r.status,
      r.reviewed_by || '',
      formatTime(r.reviewed_at),
      r.review_note || ''
    ])
  );
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="requests.csv"'
  });
  res.end(csv);
});

// 账号管理
route('GET', '/api/users', { auth: true, admin: true }, async (req, res) => {
  const rows = await db.query(
    'SELECT id, username, role, display_name, disabled, created_at FROM users ORDER BY id'
  );
  json(res, 200, { ok: true, users: rows });
});

route('POST', '/api/users', { auth: true, admin: true }, async (req, res, url, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.display_name || '').trim() || username;
  const role = String(body.role || 'user');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw badRequest('用户名需为 3-20 位字母/数字/下划线');
  if (password.length < 6) throw badRequest('密码至少 6 位');
  if (!['admin', 'user'].includes(role)) throw badRequest('角色无效');
  const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing[0]) return json(res, 409, { ok: false, error: '用户名已存在' });
  const id = await db.insert(
    'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [username, db.hashPassword(password), role, displayName, db.now()]
  );
  json(res, 200, { ok: true, id });
});

route('POST', '/api/users/:id/reset-password', { auth: true, admin: true }, async (req, res, url, body) => {
  const id = Number(req.params.id);
  const password = String(body.password || '');
  if (password.length < 6) throw badRequest('新密码至少 6 位');
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [db.hashPassword(password), id]);
  json(res, 200, { ok: true });
});

route('POST', '/api/users/:id/toggle-disabled', { auth: true, admin: true }, async (req, res, url, body, session) => {
  const id = Number(req.params.id);
  if (session.uid === id) return json(res, 409, { ok: false, error: '不能停用自己的账号' });
  await db.run('UPDATE users SET disabled = 1 - disabled WHERE id = $1', [id]);
  json(res, 200, { ok: true });
});

// ---------- 分发 ----------

async function handle(req, res, url, body) {
  const found = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
  if (!found) {
    return json(res, 404, { ok: false, error: '接口不存在' });
  }

  const session = getSession(req);
  if (found.opts.auth && !session) {
    return json(res, 401, { ok: false, error: '未登录或会话已过期，请重新登录' });
  }
  if (found.opts.admin && session.role !== 'admin') {
    return json(res, 403, { ok: false, error: '仅管理员可执行此操作' });
  }

  const match = url.pathname.match(found.regex);
  req.params = {};
  found.keys.forEach((k, i) => {
    req.params[k] = decodeURIComponent(match[i + 1]);
  });

  await found.handler(req, res, url, body, session);
}

module.exports = { handle };
