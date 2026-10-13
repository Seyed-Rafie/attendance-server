/**
 * سرور حضور و غیاب — نسخه‌ی production
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'attendance.db');
const QR_STEP_SECONDS = parseInt(process.env.QR_STEP_SECONDS || '10', 10);
const QR_TOLERANCE_SECONDS = parseInt(process.env.QR_TOLERANCE_SECONDS || '8', 10);
const EXP_GRACE_SECONDS = parseInt(process.env.EXP_GRACE_SECONDS || '3', 10);
const SEED_ON_EMPTY = process.env.SEED_ON_EMPTY !== 'false';

const now = () => Math.floor(Date.now() / 1000);
const rid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const b64url = (buf) =>
  Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY, name TEXT, token TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, name TEXT, token TEXT UNIQUE, device_id TEXT
);
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, name TEXT, teacher_id TEXT
);
CREATE TABLE IF NOT EXISTS enrollments (
  course_id TEXT, student_id TEXT,
  PRIMARY KEY (course_id, student_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, course_id TEXT, secret TEXT,
  step_seconds INTEGER, tolerance_seconds INTEGER,
  started_at INTEGER, closed_at INTEGER,
  status TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS attendance (
  session_id TEXT, student_id TEXT, status TEXT,
  device_id TEXT, scanned_at INTEGER, qr_exp INTEGER,
  PRIMARY KEY (session_id, student_id)
);
`);

(function seed() {
  if (!SEED_ON_EMPTY) return;
  if (db.prepare('SELECT COUNT(*) c FROM teachers').get().c > 0) return;

  const teacherToken = 'T_' + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO teachers(id,name,token) VALUES(?,?,?)')
    .run('t1', 'استاد نمونه', teacherToken);

  db.prepare('INSERT INTO courses(id,name,teacher_id) VALUES(?,?,?)')
    .run('c1', 'ریاضی ۱', 't1');

  const students = [];
  for (let i = 1; i <= 5; i++) {
    const sid = 's' + i;
    const token = 'S_' + crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO students(id,name,token) VALUES(?,?,?)')
      .run(sid, 'دانشجو ' + i, token);
    db.prepare('INSERT INTO enrollments(course_id,student_id) VALUES(?,?)')
      .run('c1', sid);
    students.push({ id: sid, name: 'دانشجو ' + i, token });
  }

  const tokensPath = path.join(path.dirname(DB_FILE), 'tokens.json');
  fs.writeFileSync(tokensPath, JSON.stringify({
    teacher: { id: 't1', name: 'استاد نمونه', token: teacherToken },
    students,
    course: { id: 'c1', name: 'ریاضی ۱' }
  }, null, 2));

  console.log('=== توکن‌های نمونه ===');
  console.log('Teacher:', teacherToken);
  students.forEach(s => console.log(s.id, s.token));
  console.log('توکن‌ها در', tokensPath, 'ذخیره شد');
})();

function signQR(secret, sid, exp, nonce) {
  return b64url(
    crypto.createHmac('sha256', secret)
      .update(`${sid}|${exp}|${nonce}`)
      .digest()
  );
}

function buildQR(session) {
  const step = session.step_seconds;
  const slot = Math.floor(now() / step);
  const exp = (slot + 1) * step + session.tolerance_seconds;
  const nonce = b64url(
    crypto.createHmac('sha256', session.secret)
      .update('nonce|' + slot)
      .digest()
  ).slice(0, 12);
  const sig = signQR(session.secret, session.id, exp, nonce);
  return { v: 1, sid: session.id, exp, nonce, sig, step_seconds: step };
}

function verifyQR(secret, sid, payload) {
  if (!payload || payload.v !== 1) return { ok: false, reason: 'malformed' };
  const { exp, nonce, sig } = payload;
  if (!exp || !nonce || !sig) return { ok: false, reason: 'malformed' };

  const expected = signQR(secret, sid, exp, nonce);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ok: false, reason: 'bad_signature' };

  if (now() > exp + EXP_GRACE_SECONDS) return { ok: false, reason: 'expired' };
  return { ok: true };
}

const bearer = (req) =>
  (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

function teacherAuth(req, res, next) {
  const row = db.prepare('SELECT * FROM teachers WHERE token=?').get(bearer(req));
  if (!row) return res.status(401).json({ error: 'unauthorized_teacher' });
  req.teacher = row;
  next();
}

function studentAuth(req, res, next) {
  const row = db.prepare('SELECT * FROM students WHERE token=?').get(bearer(req));
  if (!row) return res.status(401).json({ error: 'unauthorized_student' });
  req.student = row;
  next();
}

const rateMap = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = bearer(req) || req.ip;
    const nowMs = Date.now();
    const entry = rateMap.get(key) || { count: 0, reset: nowMs + windowMs };
    if (nowMs > entry.reset) { entry.count = 0; entry.reset = nowMs + windowMs; }
    entry.count++;
    rateMap.set(key, entry);
    if (entry.count > max)
      return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}

const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) =>
  res.json({ ok: true, time: now(), db: DB_FILE })
);

app.post('/api/session/start', teacherAuth, (req, res) => {
  const { course_id } = req.body || {};
  const course = db.prepare(
    'SELECT * FROM courses WHERE id=? AND teacher_id=?'
  ).get(course_id, req.teacher.id);
  if (!course) return res.status(404).json({ error: 'course_not_found' });

  db.prepare(
    `UPDATE sessions SET status='closed', closed_at=?
     WHERE course_id=? AND status='open'`
  ).run(now(), course_id);

  const sid = rid('ses');
  const secret = crypto.randomBytes(32).toString('hex');

  db.prepare(
    `INSERT INTO sessions(id,course_id,secret,step_seconds,tolerance_seconds,started_at,status)
     VALUES(?,?,?,?,?,?,?)`
  ).run(sid, course_id, secret, QR_STEP_SECONDS, QR_TOLERANCE_SECONDS, now(), 'open');

  res.json({
    session_id: sid,
    secret,
    step_seconds: QR_STEP_SECONDS,
    tolerance_seconds: QR_TOLERANCE_SECONDS,
    started_at: now()
  });
});

app.get('/api/session/:sid/qr', teacherAuth, (req, res) => {
  const s = db.prepare(
    `SELECT * FROM sessions WHERE id=? AND status='open'`
  ).get(req.params.sid);
  if (!s) return res.status(404).json({ error: 'session_not_open' });

  const owns = db.prepare(
    'SELECT 1 FROM courses WHERE id=? AND teacher_id=?'
  ).get(s.course_id, req.teacher.id);
  if (!owns) return res.status(403).json({ error: 'forbidden' });

  res.json(buildQR(s));
});

app.post('/api/session/:sid/close', teacherAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE sessions SET status='closed', closed_at=? WHERE id=?`)
    .run(now(), req.params.sid);
  res.json({ ok: true });
});

app.post(
  '/api/attendance/scan',
  studentAuth,
  rateLimit(60 * 1000, 10),
  (req, res) => {
    const { qr, device_id, biometric } = req.body || {};
    const student = req.student;

    if (!biometric || biometric.ok !== true || biometric.liveness !== true)
      return res.status(400).json({ error: 'biometric_required' });

    if (!device_id || typeof device_id !== 'string')
      return res.status(400).json({ error: 'device_id_required' });

    if (!qr || !qr.sid) return res.status(400).json({ error: 'qr_missing' });

    const session = db.prepare(
      `SELECT * FROM sessions WHERE id=? AND status='open'`
    ).get(qr.sid);
    if (!session) return res.status(400).json({ error: 'session_not_open' });

    const v = verifyQR(session.secret, session.id, qr);
    if (!v.ok) return res.status(400).json({ error: v.reason });

    const enrolled = db.prepare(
      'SELECT 1 FROM enrollments WHERE course_id=? AND student_id=?'
    ).get(session.course_id, student.id);
    if (!enrolled) return res.status(403).json({ error: 'not_enrolled' });

    if (!student.device_id) {
      db.prepare('UPDATE students SET device_id=? WHERE id=?')
        .run(device_id, student.id);
    } else if (student.device_id !== device_id) {
      return res.status(403).json({ error: 'device_mismatch' });
    }

    const clash = db.prepare(
      `SELECT student_id FROM attendance
       WHERE session_id=? AND device_id=? AND student_id<>?`
    ).get(session.id, device_id, student.id);
    if (clash)
      return res.status(409).json({ error: 'device_used_by_another_student' });

    const existing = db.prepare(
      'SELECT 1 FROM attendance WHERE session_id=? AND student_id=?'
    ).get(session.id, student.id);
    if (existing)
      return res.json({ ok: true, status: 'present', note: 'already_recorded' });

    db.prepare(
      `INSERT INTO attendance(session_id,student_id,status,device_id,scanned_at,qr_exp)
       VALUES(?,?,?,?,?,?)`
    ).run(session.id, student.id, 'present', device_id, now(), qr.exp);

    res.json({ ok: true, status: 'present' });
  }
);

app.get('/api/session/:sid/report', teacherAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: 'not_found' });

  const rows = db.prepare(
    `SELECT a.student_id, st.name, a.status, a.device_id, a.scanned_at
     FROM attendance a
     JOIN students st ON st.id = a.student_id
     WHERE a.session_id=?
     ORDER BY a.scanned_at ASC`
  ).all(req.params.sid);

  res.json({
    session_id: s.id,
    course_id: s.course_id,
    started_at: s.started_at,
    closed_at: s.closed_at,
    status: s.status,
    present_count: rows.filter(r => r.status === 'present').length,
    records: rows
  });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing...');
  db.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB file: ${DB_FILE}`);
});