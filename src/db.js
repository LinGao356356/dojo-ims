const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据库抽象层：
// - 设置了 DATABASE_URL（生产环境）时使用 PostgreSQL（pg 驱动）
// - 否则使用 Node 22 内置的 node:sqlite（本地运行，零依赖）
// 上层统一使用 $1..$n 占位符写 SQL，sqlite 适配器自动转换

let driver = null;

// 角色：admin=系统管理员（全部权限+账号管理）
//       keeper=道场管理员/仓管（审批、台账维护、点检计划、导出）
//       user=普通员工（提交申请、查看本人记录）
const SCHEMA_COMMON = {
  users: `
    id {PK},
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','keeper','user')),
    display_name TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL`,
  items: `
    id {PK},
    code TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL,
    name TEXT NOT NULL,
    sub_name TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '个',
    quantity INTEGER NOT NULL DEFAULT 0,
    borrowed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '可用' CHECK (status IN ('可用','可疑','报废')),
    keeper TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL`,
  requests: `
    id {PK},
    type TEXT NOT NULL CHECK (type IN ('borrow','return','repair','check')),
    item_id INTEGER NOT NULL REFERENCES items(id),
    ref_request_id INTEGER,
    quantity INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','finished')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    finished_by TEXT,
    finished_at TEXT`,
  check_plans: `
    id {PK},
    item_id INTEGER NOT NULL REFERENCES items(id),
    cycle_days INTEGER NOT NULL,
    last_done_at TEXT,
    next_due_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL`
};

function buildSchema(pk) {
  return Object.values(SCHEMA_COMMON)
    .map((t) => 'CREATE TABLE IF NOT EXISTS ' + Object.keys(SCHEMA_COMMON).find((k) => SCHEMA_COMMON[k] === t) + ' (' + t.replace('{PK}', pk) + ');')
    .join('\n');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function now() {
  return new Date().toISOString();
}

async function seed() {
  const userCount = await query('SELECT COUNT(*) AS c FROM users');
  if (Number(userCount[0].c) === 0) {
    const seeds = [
      ['admin', 'admin123', 'admin', '系统管理员'],
      ['keeper', 'keeper123', 'keeper', '道场管理员'],
      ['dojo', 'dojo123', 'user', '道场公用账号']
    ];
    for (const [u, p, r, n] of seeds) {
      await run(
        'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
        [u, hashPassword(p), r, n, now()]
      );
    }
    console.log('[db] 已创建初始账号: admin / keeper / dojo');
  }

  const itemCount = await query('SELECT COUNT(*) AS c FROM items');
  if (Number(itemCount[0].c) === 0) {
    const seedFile = path.join(__dirname, '..', 'seed-items.json');
    if (fs.existsSync(seedFile)) {
      const items = JSON.parse(fs.readFileSync(seedFile, 'utf8').replace(/^﻿/, ''));
      let seq = 0;
      for (const it of items) {
        seq += 1;
        const t = now();
        await run(
          `INSERT INTO items (code, area, name, sub_name, brand, unit, quantity, borrowed, status, keeper, remark, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,'','',$9,$10)`,
          [`DJ-${String(seq).padStart(4, '0')}`, it.area, it.name, it.sub_name || '', it.brand || '', it.unit || '个', it.quantity, it.status || '可用', t, t]
        );
      }
      console.log(`[db] 已导入台账 ${items.length} 条`);
    }
  }
}

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    driver = {
      type: 'pg',
      async query(sql, params) {
        const res = await pool.query(sql, params);
        return res.rows;
      },
      async run(sql, params) {
        await pool.query(sql, params);
      },
      async insert(sql, params) {
        const res = await pool.query(sql + ' RETURNING id', params);
        return res.rows[0].id;
      }
    };
    await pool.query(buildSchema('INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY'));
    console.log('[db] 使用 PostgreSQL (DATABASE_URL)');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = path.join(__dirname, '..', 'data.sqlite');
    const db = new DatabaseSync(dbFile);
    // $n 占位符转为 sqlite 的 ?，重复的 $n 按出现顺序展开对应参数
    const convert = (sql, params) => {
      const src = params || [];
      const out = [];
      const text = sql.replace(/\$(\d+)/g, (_, n) => {
        const v = src[Number(n) - 1];
        out.push(v === undefined ? null : v);
        return '?';
      });
      return [text, out];
    };
    driver = {
      type: 'sqlite',
      async query(sql, params) {
        const [text, args] = convert(sql, params);
        return db.prepare(text).all(...args);
      },
      async run(sql, params) {
        const [text, args] = convert(sql, params);
        db.prepare(text).run(...args);
      },
      async insert(sql, params) {
        const [text, args] = convert(sql, params);
        const r = db.prepare(text).run(...args);
        return Number(r.lastInsertRowid);
      }
    };
    db.exec(buildSchema('INTEGER PRIMARY KEY AUTOINCREMENT'));
    console.log('[db] 使用本地 SQLite:', dbFile);
  }
  await seed();
}

function query(sql, params) {
  return driver.query(sql, params);
}
function run(sql, params) {
  return driver.run(sql, params);
}
function insert(sql, params) {
  return driver.insert(sql, params);
}

module.exports = { init, query, run, insert, hashPassword, now };
