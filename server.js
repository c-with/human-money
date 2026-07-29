/**
 * 企业用工成本工具箱 — 后端服务
 * Port: 3100 (避免与前端静态服务 3000 冲突)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');



// ─── 第三方依赖 ────────────────────────────────────────────
let express;
try {
  express = require('express');
} catch (e) {
  console.error('缺少 express 依赖，请先运行: npm install express');
  process.exit(1);
}

const app = express();
const PORT = 3100;

// ─── 中间件 ────────────────────────────────────────────────
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_, res) => res.sendStatus(204));
app.use(express.json());

// 健康检查
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// 静态文件 —— 只暴露 public 目录
app.use(express.static(path.join(__dirname, 'public')));

// ─── 数据层 ──────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const POLICY_FILE = path.join(DATA_DIR, 'policy.json');
const DB_FILE = path.join(DATA_DIR, 'analytics.db');

const Database = require('better-sqlite3');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// 初始化表
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
    type TEXT NOT NULL,
    page TEXT,
    action TEXT,
    detail TEXT,
    ip TEXT,
    region TEXT,
    device TEXT
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
    visit_count INTEGER DEFAULT 1,
    region TEXT,
    device TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`);
// Migration: add columns if upgrading from old schema
try{db.prepare('SELECT ip FROM events LIMIT 0').get();}catch(e){db.exec('ALTER TABLE events ADD COLUMN ip TEXT');db.exec('ALTER TABLE events ADD COLUMN region TEXT');db.exec('ALTER TABLE events ADD COLUMN device TEXT');}
try{db.prepare('SELECT region FROM visitors LIMIT 0').get();}catch(e){db.exec('ALTER TABLE visitors ADD COLUMN region TEXT');db.exec('ALTER TABLE visitors ADD COLUMN device TEXT');}

const stmtInsertEvent = db.prepare('INSERT INTO events (type, page, action, detail, ip, region, device) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtUpsertVisitor = db.prepare(`
  INSERT INTO visitors (id, first_seen, last_seen, visit_count, region, device) VALUES (?, datetime('now','+8 hours'), datetime('now','+8 hours'), 1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET last_seen=datetime('now','+8 hours'), visit_count=visit_count+1
`);

function readPolicy() {
  if(!fs.existsSync(POLICY_FILE)){
    // 首次启动初始化默认参数
    const defaults=require('./default-policy.js');
    writePolicy(defaults);
    return defaults;
  }
  const raw = fs.readFileSync(POLICY_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writePolicy(data) {
  fs.writeFileSync(POLICY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 工具 ────────────────────────────────────────────────────
function ok(res, data) {
  res.json({ success: true, data });
}

function err(res, msg, status = 400) {
  res.status(status).json({ success: false, error: msg });
}

function isoNow() {
  return new Date().toISOString().replace('Z', '+08:00');
}

// ─── API 路由 ───────────────────────────────────────────────

// 获取当前策略
app.get('/api/policy/current', (_req, res) => {
  try {
    const policy = readPolicy();
    ok(res, policy.current);
  } catch (e) {
    err(res, '读取策略数据失败: ' + e.message, 500);
  }
});

// ─── 埋点 & 统计 API ───────────────────────────────────────

// UA 解析机型
function parseDevice(ua){
  if(!ua)return '未知';
  if(/iPad/i.test(ua))return 'iPad';
  if(/iPhone/i.test(ua))return 'iPhone';
  if(/Android/i.test(ua)){
    const m=ua.match(/Android.*?(\d+)/);
    return 'Android'+(m?' '+m[1]:'');
  }
  if(/Macintosh|Mac OS X/i.test(ua))return 'Mac';
  if(/Windows/i.test(ua))return 'Windows';
  if(/Linux/i.test(ua))return 'Linux';
  return '其他';
}

// IP 获取（从代理头获取真实 IP）
function getIP(req){
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket.remoteAddress || '';
}

// IP 解析地区（node-ip2region，离线数据库，中国 IP 精确到省市+ISP）
let _ip2region = null;
function ipToRegion(ip){
  if(!ip || ip === '::1' || ip === '127.0.0.1') return '本地访问';
  try{
    if(!_ip2region){
      const IP2Region = require('node-ip2region');
      _ip2region = IP2Region.create();
    }
    const result = _ip2region.binarySearchSync(ip);
    const raw = result?.region || '';
    const parts = raw.split('|');
    const province = parts[2] || '';
    const city = parts[3] || '';
    const isp = parts[4] || '';
    if(province && city && province !== '0' && city !== '0'){
      return province === city ? province + (isp && isp !== '0' ? '·' + isp : '') : province + '·' + city + (isp && isp !== '0' ? '·' + isp : '');
    }
    if(province && province !== '0') return province;
    return ip.split('.').slice(0,2).join('.')+'.x.x';
  }catch(e){
    return ip.split('.').slice(0,2).join('.')+'.x.x';
  }
}

// 埋点上报
app.post('/api/track', (req, res) => {
  try {
    const { type, page, action, detail, visitorId } = req.body;
    if (!type) return res.json({ ok: false });
    const ip = getIP(req);
    const device = parseDevice(req.headers['user-agent']);
    const region = ipToRegion(ip);
    stmtInsertEvent.run(type, page || null, action || null, detail ? JSON.stringify(detail) : null, ip, region, device);
    if (visitorId) stmtUpsertVisitor.run(visitorId, region, device);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// 统计概览（支持日期范围筛选）
app.get('/api/stats/overview', (req, res) => {
  try {
    const from = req.query.from || '';
    const to = req.query.to || '';
    let dateWhere = '';
    const params = [];
    if (from) { dateWhere += ' AND ts >= ?'; params.push(from + ' 00:00:00'); }
    if (to) { dateWhere += ' AND ts <= ?'; params.push(to + ' 23:59:59'); }

    const totalEvents = db.prepare(`SELECT COUNT(*) as c FROM events WHERE 1=1 ${dateWhere}`).get(...params).c;
    const totalVisitors = db.prepare(`SELECT COUNT(*) as c FROM visitors WHERE 1=1 ${dateWhere.replace(/ts/g,'last_seen')}`).get(...params).c;
    const todayPV = db.prepare("SELECT COUNT(*) as c FROM events WHERE ts >= date('now','+8 hours','start of day')").get().c;
    const todayUV = db.prepare("SELECT COUNT(*) as c FROM visitors WHERE last_seen >= date('now','+8 hours','start of day')").get().c;

    // 功能使用分布
    const funcUsage = db.prepare(`
      SELECT action, COUNT(*) as c FROM events WHERE type='feature' ${dateWhere} GROUP BY action ORDER BY c DESC
    `).all(...params);

    // 最近7天每日趋势
    const dailyTrend = db.prepare(`
      SELECT date(ts) as d, COUNT(*) as pv FROM events WHERE ts >= date('now','+8 hours','-7 days','start of day')
      GROUP BY date(ts) ORDER BY d
    `).all();

    // 近20条访问记录
    const recentEvents = db.prepare(`
      SELECT ts, type, page, action, detail, region, device FROM events ORDER BY id DESC LIMIT 20
    `).all();

    // 按小时分布（今天）
    const hourly = db.prepare(`
      SELECT strftime('%H', ts) as h, COUNT(*) as c FROM events
      WHERE ts >= date('now','+8 hours','start of day') GROUP BY h ORDER BY h
    `).all();

    // 离职场景分布
    const scenarioStats = db.prepare(`
      SELECT detail, COUNT(*) as c FROM events WHERE type='calc' AND action='term' ${dateWhere} GROUP BY detail ORDER BY c DESC
    `).all(...params);

    // 薪资范围分布
    const salaryRange = db.prepare(`
      SELECT
        CASE
          WHEN CAST(detail AS REAL) < 3000 THEN '<3k'
          WHEN CAST(detail AS REAL) < 5000 THEN '3-5k'
          WHEN CAST(detail AS REAL) < 8000 THEN '5-8k'
          WHEN CAST(detail AS REAL) < 12000 THEN '8-12k'
          WHEN CAST(detail AS REAL) < 20000 THEN '12-20k'
          ELSE '20k+'
        END as range,
        COUNT(*) as c
      FROM events WHERE type='calc' AND action='salary' ${dateWhere} GROUP BY range ORDER BY range
    `).all(...params);

    // 地区分布
    const regionStats = db.prepare(`
      SELECT region, COUNT(*) as c FROM events WHERE region IS NOT NULL AND region != '' ${dateWhere}
      GROUP BY region ORDER BY c DESC LIMIT 10
    `).all(...params);

    // 机型分布
    const deviceStats = db.prepare(`
      SELECT device, COUNT(*) as c FROM events WHERE device IS NOT NULL AND device != '' ${dateWhere}
      GROUP BY device ORDER BY c DESC
    `).all(...params);

    ok(res, {
      totalEvents, totalVisitors, todayPV, todayUV,
      funcUsage, dailyTrend, recentEvents, hourly, scenarioStats, salaryRange,
      regionStats, deviceStats
    });
  } catch (e) {
    err(res, '统计读取失败: ' + e.message, 500);
  }
});

// ─── 启动 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`企业用工成本工具箱 后端服务已启动: http://localhost:${PORT}`);
});
