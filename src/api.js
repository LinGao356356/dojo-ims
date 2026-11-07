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
const STATUS_LABELS = { pending: '待审批', approved: '已完成', rejected: '已驳回', finished: '已办结' };
const ROLE_LABELS = { admin: '系统管理员', keeper: '道场管理员', user: '普通员工' };

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

route('POST', '/api/change-password', { auth: true }, async (req, res, url, body, session) => {
  const oldPwd = String(body.old_password || '');
  const newPwd = String(body.new_password || '');
  if (newPwd.length < 6) throw badRequest('新密码至少 6 位');
  const rows = await db.query('SELECT * FROM users WHERE id = $1', [session.uid]);
  if (!rows[0] || !verifyPassword(oldPwd, rows[0].password_hash)) {
    return json(res, 400, { ok: false, error: '原密码不正确' });
  }
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [db.hashPassword(newPwd), session.uid]);
  json(res, 200, { ok: true });
});

// 工作台统计
route('GET', '/api/dashboard', { auth: true }, async (req, res, url, body, session) => {
  const isStaff = session.role === 'admin' || session.role === 'keeper';
  const stats = {};
  const items = await db.query(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = '可疑' THEN 1 ELSE 0 END) AS suspect,
       SUM(CASE WHEN status = '报废' THEN 1 ELSE 0 END) AS scrap,
       SUM(borrowed) AS borrowed
     FROM items`
  );
  stats.items = items[0];
  const due = await db.query(
    `SELECT p.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area, i.code AS item_code
     FROM check_plans p JOIN items i ON i.id = p.item_id
     WHERE p.active = 1 AND p.next_due_at <= $1
     ORDER BY p.next_due_at`,
    [db.now()]
  );
  stats.dueChecks = due;
  if (isStaff) {
    const pending = await db.query("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'");
    const repairing = await db.query("SELECT COUNT(*) AS c FROM requests WHERE type = 'repair' AND status = 'approved'");
    stats.pendingCount = Number(pending[0].c);
    stats.repairingCount = Number(repairing[0].c);
  } else {
    const mine = await db.query(
      'SELECT COUNT(*) AS c FROM requests WHERE created_by = $1 AND status = $2',
      [session.username, 'pending']
    );
    stats.myPendingCount = Number(mine[0].c);
    const unret = await db.query(
      "SELECT COUNT(*) AS c, COALESCE(SUM(quantity), 0) AS q FROM requests WHERE created_by = $1 AND type = 'borrow' AND status = 'approved'",
      [session.username]
    );
    stats.myUnreturnedCount = Number(unret[0].q || 0);
    stats.myUnreturnedOrders = Number(unret[0].c);
  }
  json(res, 200, { ok: true, stats });
});

// 物品档案
route('GET', '/api/items', { auth: true }, async (req, res) => {
  const rows = await db.query('SELECT * FROM items ORDER BY area, name, id');
  json(res, 200, { ok: true, items: rows });
});

function readItemPayload(body, forEdit) {
  const p = {
    code: String(body.code || '').trim(),
    area: String(body.area || '').trim(),
    name: String(body.name || '').trim(),
    sub_name: String(body.sub_name || '').trim(),
    brand: String(body.brand || '').trim(),
    unit: String(body.unit || '').trim() || '个',
    quantity: Number(body.quantity),
    keeper: String(body.keeper || '').trim(),
    remark: String(body.remark || '').trim()
  };
  if (!p.area || !p.name) throw badRequest('区域和名称必填');
  if (!Number.isInteger(p.quantity) || p.quantity < 0) throw badRequest('数量必须是非负整数');
  if (forEdit) {
    p.status = String(body.status || '').trim();
    if (!['可用', '可疑', '报废'].includes(p.status)) throw badRequest('状态必须是 可用/可疑/报废');
  }
  return p;
}

route('POST', '/api/items', { auth: true, roles: ['admin', 'keeper'] }, async (req, res, url, body) => {
  const p = readItemPayload(body, false);
  const t = db.now();
  const id = await db.insert(
    `INSERT INTO items (code, area, name, sub_name, brand, unit, quantity, borrowed, status, keeper, remark, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,'可用',$8,$9,$10,$11)`,
    [p.code, p.area, p.name, p.sub_name, p.brand, p.unit, p.quantity, p.keeper, p.remark, t, t]
  );
  json(res, 200, { ok: true, id });
});

route('PUT', '/api/items/:id', { auth: true, roles: ['admin', 'keeper'] }, async (req, res, url, body) => {
  const id = Number(req.params.id);
  const rows = await db.query('SELECT id FROM items WHERE id = $1', [id]);
  if (!rows[0]) return json(res, 404, { ok: false, error: '物品不存在' });
  const p = readItemPayload(body, true);
  await db.run(
    `UPDATE items SET code=$1, area=$2, name=$3, sub_name=$4, brand=$5, unit=$6, quantity=$7,
       status=$8, keeper=$9, remark=$10, updated_at=$11 WHERE id=$12`,
    [p.code, p.area, p.name, p.sub_name, p.brand, p.unit, p.quantity, p.status, p.keeper, p.remark, db.now(), id]
  );
  json(res, 200, { ok: true });
});

route('DELETE', '/api/items/:id', { auth: true, roles: ['admin', 'keeper'] }, async (req, res) => {
  const id = Number(req.params.id);
  const pending = await db.query(
    "SELECT COUNT(*) AS c FROM requests WHERE item_id = $1 AND status = 'pending'",
    [id]
  );
  if (Number(pending[0].c) > 0) {
    return json(res, 409, { ok: false, error: '该物品存在待审批申请，不能删除' });
  }
  await db.run('DELETE FROM check_plans WHERE item_id = $1', [id]);
  await db.run('DELETE FROM items WHERE id = $1', [id]);
  json(res, 200, { ok: true });
});

// 申请
route('GET', '/api/requests', { auth: true }, async (req, res, url, body, session) => {
  let rows;
  const baseSql = `SELECT r.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area, i.code AS item_code
     FROM requests r JOIN items i ON i.id = r.item_id`;
  if (session.role === 'admin' || session.role === 'keeper') {
    rows = await db.query(
      `${baseSql} ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.id DESC`
    );
  } else {
    rows = await db.query(`${baseSql} WHERE r.created_by = $1 ORDER BY r.id DESC`, [session.username]);
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

  // 归还申请可关联借用单：一键归还时闭环该笔借用
  let refId = null;
  if (type === 'return' && body.ref_request_id) {
    refId = Number(body.ref_request_id);
    const borrowRows = await db.query('SELECT * FROM requests WHERE id = $1', [refId]);
    const borrow = borrowRows[0];
    if (!borrow || borrow.type !== 'borrow' || borrow.created_by !== session.username) {
      throw badRequest('关联的借用单不存在或不属于您');
    }
    if (borrow.status !== 'approved') {
      throw badRequest('该借用单已归还或不可归还');
    }
    if (quantity > borrow.quantity) throw badRequest(`归还数量不能超过借用数量（${borrow.quantity}）`);
    if (borrow.item_id !== itemId) throw badRequest('归还物品与借用单不一致');
    const dup = await db.query(
      "SELECT COUNT(*) AS c FROM requests WHERE ref_request_id = $1 AND status = 'pending'",
      [refId]
    );
    if (Number(dup[0].c) > 0) throw badRequest('该借用单已有待审核的归还申请，请勿重复提交');
  }

  const id = await db.insert(
    'INSERT INTO requests (type, item_id, ref_request_id, quantity, note, status, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [type, itemId, refId, quantity, note, 'pending', session.username, db.now()]
  );
  json(res, 200, { ok: true, id });
});

route('POST', '/api/requests/:id/review', { auth: true, roles: ['admin', 'keeper'] }, async (req, res, url, body, session) => {
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
  const nowIso = db.now();

  if (action === 'approve' && request.type === 'borrow') {
    const itemRows = await db.query('SELECT * FROM items WHERE id = $1', [request.item_id]);
    const item = itemRows[0];
    if (!item) return json(res, 409, { ok: false, error: '物品已被删除，无法批准借用' });
    const available = item.quantity - item.borrowed;
    if (request.quantity > available) {
      return json(res, 409, { ok: false, error: `可借数量不足（当前可借 ${available}），无法批准` });
    }
    await db.run('UPDATE items SET borrowed = borrowed + $1, updated_at = $2 WHERE id = $3', [
      request.quantity,
      nowIso,
      request.item_id
    ]);
  }
  if (action === 'approve' && request.type === 'return') {
    await db.run(
      'UPDATE items SET borrowed = CASE WHEN borrowed - $1 < 0 THEN 0 ELSE borrowed - $1 END, updated_at = $2 WHERE id = $3',
      [request.quantity, nowIso, request.item_id]
    );
    // 归还审批通过：扣减借用单未还数量，归零时闭环（不再显示为"未归还"）
    if (request.ref_request_id) {
      await db.run(
        "UPDATE requests SET quantity = quantity - $1 WHERE id = $2 AND status = 'approved'",
        [request.quantity, request.ref_request_id]
      );
      await db.run(
        "UPDATE requests SET status = 'finished', finished_by = $1, finished_at = $2 WHERE id = $3 AND status = 'approved' AND quantity <= 0",
        [session.username, nowIso, request.ref_request_id]
      );
    }
  }
  if (action === 'approve' && request.type === 'repair') {
    await db.run("UPDATE items SET status = '可疑', updated_at = $1 WHERE id = $2", [nowIso, request.item_id]);
  }
  if (action === 'approve' && request.type === 'check') {
    // 点检通过：更新该物品的生效点检计划
    const plans = await db.query(
      'SELECT * FROM check_plans WHERE item_id = $1 AND active = 1',
      [request.item_id]
    );
    for (const plan of plans) {
      const next = new Date(Date.now() + plan.cycle_days * 86400000).toISOString();
      await db.run('UPDATE check_plans SET last_done_at = $1, next_due_at = $2 WHERE id = $3', [
        nowIso,
        next,
        plan.id
      ]);
    }
  }

  await db.run(
    'UPDATE requests SET status=$1, reviewed_by=$2, reviewed_at=$3, review_note=$4 WHERE id=$5',
    [newStatus, session.username, nowIso, reviewNote, id]
  );
  json(res, 200, { ok: true });
});

// 维修工单办结（报修申请批准后，维修完成时操作；物品状态恢复可用）
route('POST', '/api/requests/:id/finish', { auth: true, roles: ['admin', 'keeper'] }, async (req, res, url, body, session) => {
  const id = Number(req.params.id);
  const rows = await db.query('SELECT * FROM requests WHERE id = $1', [id]);
  const request = rows[0];
  if (!request) return json(res, 404, { ok: false, error: '工单不存在' });
  if (request.type !== 'repair' || request.status !== 'approved') {
    return json(res, 409, { ok: false, error: '仅"维修中"的报修工单可办结' });
  }
  const nowIso = db.now();
  await db.run('UPDATE requests SET status=$1, finished_by=$2, finished_at=$3 WHERE id=$4', [
    'finished',
    session.username,
    nowIso,
    id
  ]);
  await db.run("UPDATE items SET status = '可用', updated_at = $1 WHERE id = $2", [nowIso, request.item_id]);
  json(res, 200, { ok: true });
});

// 点检计划
route('GET', '/api/check-plans', { auth: true }, async (req, res) => {
  const rows = await db.query(
    `SELECT p.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area, i.code AS item_code, i.status AS item_status
     FROM check_plans p JOIN items i ON i.id = p.item_id
     ORDER BY p.next_due_at`
  );
  json(res, 200, { ok: true, plans: rows });
});

route('POST', '/api/check-plans', { auth: true, roles: ['admin', 'keeper'] }, async (req, res, url, body) => {
  const itemId = Number(body.item_id);
  const cycleDays = Number(body.cycle_days);
  const itemRows = await db.query('SELECT id FROM items WHERE id = $1', [itemId]);
  if (!itemRows[0]) throw badRequest('物品不存在');
  if (!Number.isInteger(cycleDays) || cycleDays <= 0) throw badRequest('点检周期必须是正整数（天）');
  const dup = await db.query('SELECT id FROM check_plans WHERE item_id = $1 AND active = 1', [itemId]);
  if (dup[0]) return json(res, 409, { ok: false, error: '该物品已有生效中的点检计划' });
  const nowIso = db.now();
  const next = new Date(Date.now() + cycleDays * 86400000).toISOString();
  const id = await db.insert(
    'INSERT INTO check_plans (item_id, cycle_days, last_done_at, next_due_at, active, created_at) VALUES ($1,$2,NULL,$3,1,$4)',
    [itemId, cycleDays, next, nowIso]
  );
  json(res, 200, { ok: true, id });
});

route('PUT', '/api/check-plans/:id', { auth: true, roles: ['admin', 'keeper'] }, async (req, res, url, body) => {
  const id = Number(req.params.id);
  const cycleDays = Number(body.cycle_days);
  const active = body.active ? 1 : 0;
  if (!Number.isInteger(cycleDays) || cycleDays <= 0) throw badRequest('点检周期必须是正整数（天）');
  const rows = await db.query('SELECT * FROM check_plans WHERE id = $1', [id]);
  if (!rows[0]) return json(res, 404, { ok: false, error: '计划不存在' });
  const next = new Date(Date.now() + cycleDays * 86400000).toISOString();
  await db.run('UPDATE check_plans SET cycle_days=$1, active=$2, next_due_at=$3 WHERE id=$4', [
    cycleDays,
    active,
    next,
    id
  ]);
  json(res, 200, { ok: true });
});

route('DELETE', '/api/check-plans/:id', { auth: true, roles: ['admin', 'keeper'] }, async (req, res) => {
  await db.run('DELETE FROM check_plans WHERE id = $1', [Number(req.params.id)]);
  json(res, 200, { ok: true });
});

// 导出
route('GET', '/api/export/items', { auth: true, roles: ['admin', 'keeper'] }, async (req, res) => {
  const rows = await db.query('SELECT * FROM items ORDER BY area, name, id');
  const csv = toCsv(
    ['编号', '区域', '名称', '细分', '品牌', '单位', '总数', '已借出', '可借', '状态', '负责人', '备注'],
    rows.map((r) => [
      r.code, r.area, r.name, r.sub_name, r.brand, r.unit, r.quantity, r.borrowed,
      r.quantity - r.borrowed, r.status, r.keeper, r.remark
    ])
  );
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="items.csv"'
  });
  res.end(csv);
});

route('GET', '/api/export/requests', { auth: true, roles: ['admin', 'keeper'] }, async (req, res) => {
  const rows = await db.query(
    `SELECT r.*, i.name AS item_name, i.sub_name AS item_sub_name, i.area AS item_area, i.code AS item_code
     FROM requests r JOIN items i ON i.id = r.item_id ORDER BY r.id`
  );
  const csv = toCsv(
    ['单号', '类型', '编号', '区域', '物品名称', '细分', '数量', '事由', '申请人', '申请时间', '状态', '审批人', '审批时间', '审批意见', '办结人', '办结时间'],
    rows.map((r) => [
      r.id, TYPE_LABELS[r.type] || r.type, r.item_code, r.item_area, r.item_name, r.item_sub_name,
      r.quantity, r.note, r.created_by, formatTime(r.created_at),
      STATUS_LABELS[r.status] || r.status, r.reviewed_by || '', formatTime(r.reviewed_at),
      r.review_note || '', r.finished_by || '', formatTime(r.finished_at)
    ])
  );
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="requests.csv"'
  });
  res.end(csv);
});

// 账号管理
route('GET', '/api/users', { auth: true, roles: ['admin'] }, async (req, res) => {
  const rows = await db.query(
    'SELECT id, username, role, display_name, disabled, created_at FROM users ORDER BY id'
  );
  json(res, 200, { ok: true, users: rows });
});

route('POST', '/api/users', { auth: true, roles: ['admin'] }, async (req, res, url, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.display_name || '').trim() || username;
  const role = String(body.role || 'user');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw badRequest('用户名需为 3-20 位字母/数字/下划线');
  if (password.length < 6) throw badRequest('密码至少 6 位');
  if (!Object.keys(ROLE_LABELS).includes(role)) throw badRequest('角色无效');
  const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing[0]) return json(res, 409, { ok: false, error: '用户名已存在' });
  const id = await db.insert(
    'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [username, db.hashPassword(password), role, displayName, db.now()]
  );
  json(res, 200, { ok: true, id });
});

route('POST', '/api/users/:id/reset-password', { auth: true, roles: ['admin'] }, async (req, res, url, body) => {
  const id = Number(req.params.id);
  const password = String(body.password || '');
  if (password.length < 6) throw badRequest('新密码至少 6 位');
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [db.hashPassword(password), id]);
  json(res, 200, { ok: true });
});

route('POST', '/api/users/:id/role', { auth: true, roles: ['admin'] }, async (req, res, url, body, session) => {
  const id = Number(req.params.id);
  const role = String(body.role || '');
  if (!Object.keys(ROLE_LABELS).includes(role)) throw badRequest('角色无效');
  if (session.uid === id) return json(res, 409, { ok: false, error: '不能修改自己的角色' });
  await db.run('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  json(res, 200, { ok: true });
});

route('POST', '/api/users/:id/toggle-disabled', { auth: true, roles: ['admin'] }, async (req, res, url, body, session) => {
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
  if (found.opts.roles && !found.opts.roles.includes(session.role)) {
    return json(res, 403, { ok: false, error: '当前角色无权执行此操作' });
  }

  const match = url.pathname.match(found.regex);
  req.params = {};
  found.keys.forEach((k, i) => {
    req.params[k] = decodeURIComponent(match[i + 1]);
  });

  await found.handler(req, res, url, body, session);
}

module.exports = { handle };
