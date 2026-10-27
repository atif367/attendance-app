/* =========================================================
   STATE + API
   Data lives in SQLite on the server; the page only keeps
   a working copy (students list and the Daily tab draft).
   ========================================================= */
let students    = [];    // [{roll, name, dept}]
let draft       = {};    // working copy for the Daily tab: { roll: [1,1,0,1,1,1,1] }  1 = P, 0 = A
let draftExists = false; // true when the selected date already has saved records
let editingRoll = null;

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new Error('Cannot reach the server.'); }

  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ').');
  return data;
}

/* run an async handler and show any error as a toast */
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (e) { msg(e.message, true); }
  };
}

/* ---------- small helpers ---------- */
let toastTimer;
function msg(text, isError) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2500);
}
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
function paint(btn, v) {
  btn.textContent = v ? 'P' : 'A';
  btn.className = 'mark ' + (v ? 'p' : 'a');
}
function getThreshold(id) {
  const v = parseFloat(document.getElementById(id).value);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 75;
}
function emptyRow(tbody, cols, text) {
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = cols;
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

/* =========================================================
   TABS
   ========================================================= */
document.querySelectorAll('nav button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  };
});

/* =========================================================
   MODULE 1 : STUDENT MANAGEMENT
   ========================================================= */
const studentForm = document.getElementById('studentForm');
const sRoll = document.getElementById('sRoll');
const sName = document.getElementById('sName');
const sDept = document.getElementById('sDept');
const sSubmit = document.getElementById('sSubmit');
const sCancel = document.getElementById('sCancel');

function resetStudentForm() {
  editingRoll = null;
  sSubmit.textContent = 'Add Student';
  sCancel.style.display = 'none';
  studentForm.reset();
  sDept.value = 'CSE (AI & ML)';
}

studentForm.onsubmit = guard(async e => {
  e.preventDefault();
  const roll = sRoll.value.trim();
  const name = sName.value.trim();
  const dept = sDept.value.trim() || 'CSE (AI & ML)';

  if (!roll || !name) { msg('Roll number and name are required.', true); return; }

  if (editingRoll === null) {
    await api('POST', '/api/students', { roll, name, dept });
    msg('Student ' + roll + ' added.');
  } else {
    await api('PUT', '/api/students/' + encodeURIComponent(editingRoll), { roll, name, dept });
    msg('Student updated.');
  }

  resetStudentForm();
  await refreshAll();
});

sCancel.onclick = resetStudentForm;

document.getElementById('sSample').onclick = guard(async () => {
  const r = await api('POST', '/api/students/sample');
  await refreshAll();
  msg(r.added ? r.added + ' sample students added.' : 'Sample class already present.');
});

document.getElementById('sClear').onclick = guard(async () => {
  if (!confirm('Delete ALL students and attendance records?')) return;
  await api('DELETE', '/api/data');
  resetStudentForm();
  await refreshAll();
  msg('All data cleared.');
});

function renderStudents() {
  const tbody = document.querySelector('#studentTable tbody');
  tbody.innerHTML = '';

  if (!students.length) {
    emptyRow(tbody, 4, 'No students registered. Add one above or click "Load Sample Class".');
    return;
  }

  students.forEach(s => {
    const tr = document.createElement('tr');
    [s.roll, s.name, s.dept].forEach(v => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });

    const td = document.createElement('td');

    const eb = document.createElement('button');
    eb.textContent = 'Edit';
    eb.onclick = () => {
      editingRoll = s.roll;
      sRoll.value = s.roll;
      sName.value = s.name;
      sDept.value = s.dept;
      sSubmit.textContent = 'Update Student';
      sCancel.style.display = '';
      sRoll.focus();
    };

    const db = document.createElement('button');
    db.textContent = 'Delete';
    db.onclick = guard(async () => {
      if (!confirm('Delete student ' + s.roll + ' (' + s.name + ')?')) return;
      await api('DELETE', '/api/students/' + encodeURIComponent(s.roll));
      await refreshAll();
      msg('Student deleted.');
    });

    td.append(eb, document.createTextNode(' '), db);
    tr.appendChild(td);
    tbody.appendChild(tr);
  });
}

/* =========================================================
   MODULE 2 : DAILY ATTENDANCE
   ========================================================= */
const attDate = document.getElementById('attDate');
let draftSeq = 0;   // ignore replies from an older date selection

async function loadDraft(date) {
  const seq = ++draftSeq;
  let saved = {};
  draftExists = false;

  if (date && students.length) {
    const r = await api('GET', '/api/attendance/' + date);
    if (seq !== draftSeq) return;
    saved = r.records;
    draftExists = r.exists;
  }

  draft = {};
  students.forEach(s => {
    const rec = saved[s.roll];
    draft[s.roll] = (Array.isArray(rec) && rec.length === 7)
      ? rec.slice()
      : [1, 1, 1, 1, 1, 1, 1];   // default: all present
  });
  renderDaily();
}

function renderDaily() {
  const date = attDate.value;
  const tbody = document.querySelector('#dailyTable tbody');
  const info  = document.getElementById('dailyInfo');
  tbody.innerHTML = '';

  if (!students.length) {
    emptyRow(tbody, 11, 'No students registered. Add students in the Students tab.');
    info.textContent = '';
    return;
  }
  if (!date) {
    emptyRow(tbody, 11, 'Select an attendance date.');
    info.textContent = '';
    return;
  }

  info.textContent = draftExists
    ? 'Existing records for ' + date + ' loaded — saving will update them.'
    : 'New attendance sheet for ' + date + '.';

  students.forEach(s => {
    if (!draft[s.roll]) draft[s.roll] = [1, 1, 1, 1, 1, 1, 1];

    const tr = document.createElement('tr');

    const tdRoll = document.createElement('td');
    tdRoll.textContent = s.roll;
    const tdName = document.createElement('td');
    tdName.textContent = s.name;
    tr.append(tdRoll, tdName);

    for (let p = 0; p < 7; p++) {
      const td = document.createElement('td');
      const b  = document.createElement('button');
      b.className = 'mark';
      b.onclick = () => {
        draft[s.roll][p] = draft[s.roll][p] ? 0 : 1;
        paint(b, draft[s.roll][p]);
        refreshTotals();
      };
      paint(b, draft[s.roll][p]);
      td.appendChild(b);
      tr.appendChild(td);
    }

    const tdP = document.createElement('td');
    const tdA = document.createElement('td');
    tr.append(tdP, tdA);

    function refreshTotals() {
      let p = 0;
      draft[s.roll].forEach(v => { if (v === 1) p++; });
      tdP.textContent = p;
      tdA.textContent = 7 - p;
    }
    refreshTotals();

    tbody.appendChild(tr);
  });
}

attDate.onchange = guard(() => loadDraft(attDate.value));

document.getElementById('allPresent').onclick = () => {
  if (!students.length) { msg('No students registered.', true); return; }
  students.forEach(s => { draft[s.roll] = [1, 1, 1, 1, 1, 1, 1]; });
  renderDaily();
};

document.getElementById('allAbsent').onclick = () => {
  if (!students.length) { msg('No students registered.', true); return; }
  students.forEach(s => { draft[s.roll] = [0, 0, 0, 0, 0, 0, 0]; });
  renderDaily();
};

document.getElementById('saveAtt').onclick = guard(async () => {
  const date = attDate.value;
  if (!date) { msg('Select a date first.', true); return; }
  if (!students.length) { msg('No students to save.', true); return; }

  // same date + student + period => updated on the server, never duplicated
  const r = await api('PUT', '/api/attendance/' + date, { records: draft });
  await refreshAll();
  msg(r.updated ? 'Attendance updated for ' + date : 'Attendance saved for ' + date);
});

/* =========================================================
   MODULE 3 : RECORD MANAGEMENT
   ========================================================= */
async function viewDate(date) {
  const box = document.getElementById('recView');
  box.innerHTML = '';

  const r = await api('GET', '/api/attendance/' + date);
  if (!r.exists) { box.textContent = 'No attendance saved for ' + date + '.'; return; }
  const rec = r.records;

  const h = document.createElement('h2');
  h.textContent = 'Attendance for ' + date;
  box.appendChild(h);

  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th>Roll No</th><th>Student</th><th>P1</th><th>P2</th><th>P3</th>' +
    '<th>P4</th><th>P5</th><th>P6</th><th>P7</th><th>Attended</th></tr></thead>';

  const tbody = document.createElement('tbody');
  students.forEach(s => {
    const arr = rec[s.roll];
    if (!arr) return;

    const tr = document.createElement('tr');
    const tdRoll = document.createElement('td'); tdRoll.textContent = s.roll;
    const tdName = document.createElement('td'); tdName.textContent = s.name;
    tr.append(tdRoll, tdName);

    let present = 0;
    arr.forEach(v => {
      const td = document.createElement('td');
      td.textContent = v ? 'P' : 'A';
      td.className = v ? 'p' : 'a';
      if (v) present++;
      tr.appendChild(td);
    });

    const tdTot = document.createElement('td');
    tdTot.textContent = present + ' / 7';
    tr.appendChild(tdTot);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  box.appendChild(table);
}

document.getElementById('recViewBtn').onclick = guard(async () => {
  const d = document.getElementById('recDate').value;
  if (!d) { msg('Select a date.', true); return; }
  await viewDate(d);
});

async function renderRecords() {
  const tbody = document.querySelector('#recDates tbody');
  const list = await api('GET', '/api/attendance');
  tbody.innerHTML = '';

  if (!list.length) {
    emptyRow(tbody, 5, 'No attendance saved yet.');
    return;
  }

  list.forEach(r => {
    const d = r.date;
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td'); tdDate.textContent = d;
    const tdCnt  = document.createElement('td'); tdCnt.textContent = r.students;
    const tdP    = document.createElement('td'); tdP.textContent = r.present;
    const tdA    = document.createElement('td'); tdA.textContent = r.absent;

    const tdAct = document.createElement('td');

    const vb = document.createElement('button');
    vb.textContent = 'View';
    vb.onclick = guard(async () => {
      document.getElementById('recDate').value = d;
      await viewDate(d);
      document.getElementById('recView').scrollIntoView({ behavior: 'smooth' });
    });

    const eb = document.createElement('button');
    eb.textContent = 'Edit';
    eb.onclick = guard(async () => {
      attDate.value = d;
      await loadDraft(d);
      document.querySelector('nav button[data-tab="daily"]').click();
    });

    const db = document.createElement('button');
    db.textContent = 'Delete';
    db.onclick = guard(async () => {
      if (!confirm('Delete the attendance of ' + d + '?')) return;
      await api('DELETE', '/api/attendance/' + d);
      await refreshAll();
      msg('Records of ' + d + ' deleted.');
    });

    tdAct.append(vb, document.createTextNode(' '), eb, document.createTextNode(' '), db);
    tr.append(tdDate, tdCnt, tdP, tdA, tdAct);
    tbody.appendChild(tr);
  });
}

/* =========================================================
   MODULE 4 : MONTHLY CALCULATION  (calculated on the server)
   ========================================================= */
let monSeq = 0;

async function renderMonthly() {
  const month = document.getElementById('monMonth').value;
  const threshold = getThreshold('monThreshold');
  const tbody = document.querySelector('#monTable tbody');
  const summary = document.getElementById('monSummary');
  const seq = ++monSeq;

  if (!month) { tbody.innerHTML = ''; summary.textContent = 'Select a month.'; return; }

  const { dates, workingPeriods, rows } = await api('GET', '/api/monthly/' + month + '?threshold=' + threshold);
  if (seq !== monSeq) return;
  tbody.innerHTML = '';

  summary.textContent =
    'Month: ' + month +
    ' | Days recorded: ' + dates.length +
    ' | Working periods: ' + workingPeriods +
    ' | Students: ' + rows.length +
    ' | Below ' + threshold + '%: ' + rows.filter(r => r.status === 'LOW').length;

  if (!rows.length) { emptyRow(tbody, 7, 'No students registered.'); return; }

  rows.forEach(r => {
    const tr = document.createElement('tr');
    const cells = [
      r.roll, r.name, r.attended, r.absent, r.total,
      r.total ? r.pct.toFixed(2) + '%' : '—'
    ];
    cells.forEach(v => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });

    const tdS = document.createElement('td');
    tdS.textContent = r.status;
    if (r.status === 'LOW') tdS.className = 'low';
    tr.appendChild(tdS);

    tbody.appendChild(tr);
  });
}

document.getElementById('monMonth').onchange = guard(renderMonthly);
document.getElementById('monThreshold').oninput = guard(renderMonthly);

/* =========================================================
   MODULE 5 : REPORTS
   ========================================================= */
let repSeq = 0;

async function renderReports() {
  const month = document.getElementById('repMonth').value;
  const threshold = getThreshold('repThreshold');
  const tbody = document.querySelector('#repTable tbody');
  const hbody = document.querySelector('#histTable tbody');
  const summary = document.getElementById('repSummary');
  const seq = ++repSeq;

  if (!month) {
    tbody.innerHTML = ''; hbody.innerHTML = '';
    summary.textContent = 'Select a month.';
    return;
  }

  const [report, history] = await Promise.all([
    api('GET', '/api/monthly/' + month + '?threshold=' + threshold),
    api('GET', '/api/history/' + month)
  ]);
  if (seq !== repSeq) return;

  tbody.innerHTML = '';
  hbody.innerHTML = '';

  const { dates, workingPeriods, rows } = report;
  const low = rows.filter(r => r.status === 'LOW').length;

  summary.textContent =
    'Month: ' + month +
    ' | Days recorded: ' + dates.length +
    ' | Class working periods: ' + workingPeriods +
    ' | Students below ' + threshold + '%: ' + low;

  /* --- student-wise monthly report --- */
  if (!rows.length) {
    emptyRow(tbody, 8, 'No students registered.');
  } else {
    rows.forEach(r => {
      const tr = document.createElement('tr');
      const cells = [
        r.roll, r.name, r.dept, r.attended, r.absent, r.total,
        r.total ? r.pct.toFixed(2) + '%' : '—'
      ];
      cells.forEach(v => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      const tdS = document.createElement('td');
      tdS.textContent = r.status;
      if (r.status === 'LOW') tdS.className = 'low';
      tr.appendChild(tdS);
      tbody.appendChild(tr);
    });
  }

  /* --- daily attendance history --- */
  if (!history.length) {
    emptyRow(hbody, 5, 'No attendance recorded this month.');
  } else {
    history.forEach(h => {
      const tr = document.createElement('tr');
      [h.date, h.day, h.students, h.present, h.absent].forEach(v => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      hbody.appendChild(tr);
    });
  }
}

document.getElementById('repMonth').onchange = guard(renderReports);
document.getElementById('repThreshold').oninput = guard(renderReports);

/* --- CSV export (file is generated by the server) --- */
document.getElementById('exportBtn').onclick = guard(async () => {
  const month = document.getElementById('repMonth').value;
  const threshold = getThreshold('repThreshold');
  if (!month) { msg('Select a month first.', true); return; }

  const res = await fetch('/api/reports/' + month + '/csv?threshold=' + threshold);
  if (!res.ok) {
    let err = 'Export failed.';
    try { err = (await res.json()).error || err; } catch (e) { /* keep default */ }
    throw new Error(err);
  }

  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'attendance_' + month + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);

  msg('Monthly report exported as CSV.');
});

/* =========================================================
   REFRESH + INIT
   ========================================================= */
async function refreshAll() {
  students = await api('GET', '/api/students');
  renderStudents();
  await Promise.all([
    loadDraft(attDate.value),
    renderRecords(),
    renderMonthly(),
    renderReports()
  ]);
}

const init = guard(async () => {
  const t = todayStr();
  attDate.value = t;
  document.getElementById('recDate').value = t;
  document.getElementById('monMonth').value = t.slice(0, 7);
  document.getElementById('repMonth').value = t.slice(0, 7);

  await refreshAll();
});

init();
