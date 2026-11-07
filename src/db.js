const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据库抽象层：
// - 设置了 DATABASE_URL（Render/Neon 生产环境）时使用 PostgreSQL（pg 驱动）
// - 否则使用 Node 22 内置的 node:sqlite（本地开发，零依赖）
// 上层统一使用 $1..$n 占位符写 SQL，sqlite 适配器会自动转换为 ?

let driver = null;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  display_name TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  area TEXT NOT NULL,
  name TEXT NOT NULL,
  sub_name TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  borrowed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '可用' CHECK (status IN ('可用','可疑','报废')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('borrow','return','repair','check')),
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
`;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  display_name TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL,
  name TEXT NOT NULL,
  sub_name TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  borrowed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '可用' CHECK (status IN ('可用','可疑','报废')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('borrow','return','repair','check')),
  item_id INTEGER NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
`;

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
    await run(
      'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
      ['admin', hashPassword('admin123'), 'admin', '管理员', now()]
    );
    await run(
      'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
      ['dojo', hashPassword('dojo123'), 'user', '道场公用账号', now()]
    );
    console.log('[db] 已创建初始账号: admin / dojo');
  }

  const itemCount = await query('SELECT COUNT(*) AS c FROM items');
  if (Number(itemCount[0].c) === 0) {
    const seedFile = path.join(__dirname, '..', 'seed-items.json');
    if (fs.existsSync(seedFile)) {
      const items = JSON.parse(fs.readFileSync(seedFile, 'utf8').replace(/^﻿/, ''));
      for (const it of items) {
        await run(
          'INSERT INTO items (area, name, sub_name, brand, quantity, borrowed, status, created_at) VALUES ($1,$2,$3,$4,$5,0,$6,$7)',
          [it.area, it.name, it.sub_name || '', it.brand || '', it.quantity, it.status || '可用', now()]
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
    await pool.query(SCHEMA_PG);
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
    db.exec(SCHEMA_SQLITE);
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
