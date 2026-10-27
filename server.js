/* =========================================================
   Student Attendance Management System - backend
   Express + SQLite (node:sqlite, built into Node 22.13+)
   ========================================================= */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT, 10) || 8081;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'attendance.db');
const PERIODS = 7;
const DEFAULT_DEPT = 'CSE (AI & ML)';

/* ---------- database ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    roll TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dept TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attendance (
    roll   TEXT    NOT NULL REFERENCES students(roll) ON UPDATE CASCADE ON DELETE CASCADE,
    date   TEXT    NOT NULL,
    period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 7),
    status INTEGER NOT NULL CHECK (status IN (0, 1)),
    PRIMARY KEY (roll, date, period)
  );

  CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ---------- validation helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function isMonth(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }

function needDate(s) { if (!isDate(s)) throw new HttpError(400, 'Invalid date. Use YYYY-MM-DD.'); return s; }
function needMonth(s) { if (!isMonth(s)) throw new HttpError(400, 'Invalid month. Use YYYY-MM.'); return s; }

function threshold(q) {
  const v = parseFloat(q);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 75;
}

function cleanStudent(body) {
  body = body || {};
  const roll = typeof body.roll === 'string' ? body.roll.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  let dept = typeof body.dept === 'string' ? body.dept.trim() : '';
  if (!roll || !name) throw new HttpError(400, 'Roll number and name are required.');
  if (roll.length > 30 || name.length > 100 || dept.length > 100) {
    throw new HttpError(400, 'Roll number, name or department is too long.');
  }
  if (!dept) dept = DEFAULT_DEPT;
  return { roll, name, dept };
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

/* =========================================================
   MODULE 1 : STUDENTS
   ========================================================= */
app.get('/api/students', (req, res) => {
  res.json(db.prepare('SELECT roll, name, dept FROM students ORDER BY rowid').all());
});

app.post('/api/students', (req, res) => {
  const s = cleanStudent(req.body);
  if (db.prepare('SELECT 1 FROM students WHERE roll = ?').get(s.roll)) {
    throw new HttpError(409, 'Roll number already exists.');
  }
  db.prepare('INSERT INTO students (roll, name, dept) VALUES (?, ?, ?)').run(s.roll, s.name, s.dept);
  res.status(201).json(s);
});

app.post('/api/students/sample', (req, res) => {
  const ins = db.prepare('INSERT OR IGNORE INTO students (roll, name, dept) VALUES (?, ?, ?)');
  let added = 0;
  tx(() => {
    for (let i = 1; i <= 10; i++) {
      added += Number(ins.run(String(100 + i), 'Student ' + i, DEFAULT_DEPT).changes);
    }
  });
  res.json({ added });
});

app.put('/api/students/:roll', (req, res) => {
  const old = req.params.roll;
  const s = cleanStudent(req.body);
  if (!db.prepare('SELECT 1 FROM students WHERE roll = ?').get(old)) {
    throw new HttpError(404, 'Student not found.');
  }
  if (s.roll !== old && db.prepare('SELECT 1 FROM students WHERE roll = ?').get(s.roll)) {
    throw new HttpError(409, 'Roll number already exists.');
  }
  // ON UPDATE CASCADE moves the student's attendance rows to the new roll number
  db.prepare('UPDATE students SET roll = ?, name = ?, dept = ? WHERE roll = ?')
    .run(s.roll, s.name, s.dept, old);
  res.json(s);
});

app.delete('/api/students/:roll', (req, res) => {
  // ON DELETE CASCADE removes the student's attendance rows
  const r = db.prepare('DELETE FROM students WHERE roll = ?').run(req.params.roll);
  if (!Number(r.changes)) throw new HttpError(404, 'Student not found.');
  res.json({ deleted: req.params.roll });
});

app.delete('/api/data', (req, res) => {
  tx(() => {
    db.exec('DELETE FROM attendance');
    db.exec('DELETE FROM students');
  });
  res.json({ cleared: true });
});

/* =========================================================
   MODULE 2 + 3 : DAILY ATTENDANCE AND RECORD MANAGEMENT
   ========================================================= */

// list of saved dates with totals
app.get('/api/attendance', (req, res) => {
  res.json(db.prepare(`
    SELECT date,
           COUNT(DISTINCT roll) AS students,
           SUM(status)          AS present,
           SUM(1 - status)      AS absent
    FROM attendance
    GROUP BY date
    ORDER BY date DESC
  `).all());
});

// one day: { exists, records: { roll: [p1..p7] } }
app.get('/api/attendance/:date', (req, res) => {
  const date = needDate(req.params.date);
  const rows = db.prepare(
    'SELECT roll, period, status FROM attendance WHERE date = ? ORDER BY roll, period'
  ).all(date);

  const records = {};
  rows.forEach(r => {
    if (!records[r.roll]) records[r.roll] = new Array(PERIODS).fill(0);
    records[r.roll][r.period - 1] = r.status;
  });
  res.json({ date, exists: rows.length > 0, records });
});

// save or update one day. Same (student, date, period) is updated, never duplicated.
app.put('/api/attendance/:date', (req, res) => {
  const date = needDate(req.params.date);
  const records = req.body && req.body.records;
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    throw new HttpError(400, 'records object is required.');
  }
  const rolls = Object.keys(records);
  if (!rolls.length) throw new HttpError(400, 'No attendance records supplied.');

  const exists = db.prepare('SELECT 1 FROM students WHERE roll = ?');
  rolls.forEach(roll => {
    const arr = records[roll];
    if (!exists.get(roll)) throw new HttpError(400, 'Unknown student: ' + roll);
    if (!Array.isArray(arr) || arr.length !== PERIODS || !arr.every(v => v === 0 || v === 1)) {
      throw new HttpError(400, 'Attendance for ' + roll + ' must be ' + PERIODS + ' values of 0 or 1.');
    }
  });

  const existed = !!db.prepare('SELECT 1 FROM attendance WHERE date = ? LIMIT 1').get(date);
  const upsert = db.prepare(`
    INSERT INTO attendance (roll, date, period, status) VALUES (?, ?, ?, ?)
    ON CONFLICT (roll, date, period) DO UPDATE SET status = excluded.status
  `);
  tx(() => {
    rolls.forEach(roll => {
      records[roll].forEach((v, i) => upsert.run(roll, date, i + 1, v));
    });
  });
  res.status(existed ? 200 : 201).json({ date, updated: existed, students: rolls.length });
});

app.delete('/api/attendance/:date', (req, res) => {
  const date = needDate(req.params.date);
  const r = db.prepare('DELETE FROM attendance WHERE date = ?').run(date);
  if (!Number(r.changes)) throw new HttpError(404, 'No attendance saved for ' + date + '.');
  res.json({ deleted: date });
});

/* =========================================================
   MODULE 4 : MONTHLY CALCULATION
   ========================================================= */
function computeMonth(month, thr) {
  const dates = db.prepare(
    'SELECT DISTINCT date FROM attendance WHERE substr(date, 1, 7) = ? ORDER BY date'
  ).all(month).map(r => r.date);

  const rows = db.prepare(`
    SELECT s.roll, s.name, s.dept,
           COALESCE(SUM(a.status), 0) AS attended,
           COUNT(a.status)            AS total
    FROM students s
    LEFT JOIN attendance a ON a.roll = s.roll AND substr(a.date, 1, 7) = ?
    GROUP BY s.roll
    ORDER BY s.rowid
  `).all(month).map(r => {
    const attended = Number(r.attended);
    const total = Number(r.total);
    const pct = total ? (attended / total) * 100 : 0;
    return {
      roll: r.roll, name: r.name, dept: r.dept,
      attended, absent: total - attended, total, pct,
      status: total === 0 ? 'No data' : (pct < thr ? 'LOW' : 'OK')
    };
  });

  return { month, threshold: thr, dates, workingPeriods: dates.length * PERIODS, rows };
}

app.get('/api/monthly/:month', (req, res) => {
  res.json(computeMonth(needMonth(req.params.month), threshold(req.query.threshold)));
});

/* =========================================================
   MODULE 5 : REPORTS
   ========================================================= */
app.get('/api/history/:month', (req, res) => {
  const month = needMonth(req.params.month);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = db.prepare(`
    SELECT date,
           COUNT(DISTINCT roll) AS students,
           SUM(status)          AS present,
           SUM(1 - status)      AS absent
    FROM attendance
    WHERE substr(date, 1, 7) = ?
    GROUP BY date
    ORDER BY date DESC
  `).all(month).map(r => ({
    date: r.date,
    day: days[new Date(r.date + 'T00:00:00Z').getUTCDay()],
    students: Number(r.students),
    present: Number(r.present),
    absent: Number(r.absent)
  }));
  res.json(rows);
});

function csvCell(v) {
  let s = String(v);
  // stop spreadsheet apps from running a name such as =cmd(...) as a formula
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

app.get('/api/reports/:month/csv', (req, res) => {
  const month = needMonth(req.params.month);
  const { rows } = computeMonth(month, threshold(req.query.threshold));
  if (!rows.length) throw new HttpError(404, 'Nothing to export.');

  const lines = [[
    'Roll No', 'Student Name', 'Department', 'Attended',
    'Absent', 'Total Periods', 'Percentage', 'Status'
  ]];
  rows.forEach(r => lines.push([
    r.roll, r.name, r.dept, r.attended, r.absent, r.total,
    r.total ? r.pct.toFixed(2) : '0.00', r.status
  ]));

  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="attendance_' + month + '.csv"'
  });
  res.send(lines.map(row => row.map(csvCell).join(',')).join('\n'));
});

/* ---------- errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log('Attendance app on port ' + PORT + ' (db: ' + DB_PATH + ')'));
}

module.exports = app;
