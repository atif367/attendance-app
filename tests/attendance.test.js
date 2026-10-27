/* =========================================================
   Selenium WebDriver tests - Student Attendance Management System
   Run:  cd tests && npm ci && npm test

   Environment variables (all optional)
     ATTENDANCE_URL     app address              default http://localhost:8081
     CHROME_BIN         path to Chrome binary    default: Selenium finds Chrome
     CHROMEDRIVER_PATH  path to chromedriver     default: Selenium Manager downloads it
     CHROMEDRIVER_ARGS  extra chromedriver args
     RESTART_CMD        command that restarts the app (persistence test)
     TEST_CONTAINER     Docker container name; used as "docker restart <name>"
                        when RESTART_CMD is not set (the Jenkinsfile sets it)
   ========================================================= */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const BASE = process.env.ATTENDANCE_URL || 'http://localhost:8081';
const WAIT = 10000;

/* ---------- test data ---------- */
const STUDENTS = [
  { roll: '101', name: 'Asha',  dept: 'CSE (AI & ML)' },
  { roll: '102', name: 'Ravi',  dept: 'CSE (AI & ML)' },
  { roll: '103', name: 'Meena', dept: 'CSE (AI & ML)' },
  { roll: '104', name: 'Kiran', dept: 'CSE (AI & ML)' }
];
const DAY1 = '2026-09-01';
const DAY2 = '2026-09-02';
const MONTH = '2026-09';
const ALL = [1, 1, 1, 1, 1, 1, 1];

// 14 periods per student over the two days
const ATT = {
  [DAY1]: {
    101: ALL,
    102: [1, 1, 1, 1, 1, 0, 0],
    103: [0, 0, 0, 0, 0, 0, 0],
    104: [1, 1, 1, 1, 1, 0, 0]
  },
  [DAY2]: {
    101: [1, 1, 1, 1, 1, 1, 0],
    102: ALL,
    103: [1, 1, 1, 1, 1, 0, 0],
    104: [1, 1, 1, 1, 1, 0, 0]
  }
};
// expected monthly result: roll -> [attended, absent, total, percentage, status]
const EXPECTED = {
  101: ['13', '1', '14', '92.86%', 'OK'],
  102: ['12', '2', '14', '85.71%', 'OK'],
  103: ['5',  '9', '14', '35.71%', 'LOW'],
  104: ['10', '4', '14', '71.43%', 'LOW']
};

/* ---------- server helpers (used to prepare data quickly) ---------- */
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + text);
  return text ? JSON.parse(text) : null;
}
const resetData = () => api('DELETE', '/api/data');
async function seedStudents(list = STUDENTS) {
  for (const s of list) await api('POST', '/api/students', s);
}
async function seedAttendance() {
  for (const date of Object.keys(ATT)) await api('PUT', '/api/attendance/' + date, { records: ATT[date] });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Application did not respond at ' + BASE);
}

/* ---------- browser ---------- */
let driver;
let downloadDir;

function buildDriver() {
  const opts = new chrome.Options();
  opts.addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,1000');
  if (process.env.CHROME_BIN) opts.setChromeBinaryPath(process.env.CHROME_BIN);
  opts.setUserPreferences({
    'download.default_directory': downloadDir,
    'download.prompt_for_download': false
  });

  const builder = new Builder().forBrowser('chrome').setChromeOptions(opts);
  if (process.env.CHROMEDRIVER_PATH) {
    const service = new chrome.ServiceBuilder(process.env.CHROMEDRIVER_PATH);
    if (process.env.CHROMEDRIVER_ARGS) service.addArguments(...process.env.CHROMEDRIVER_ARGS.split(' '));
    builder.setChromeService(service);
  }
  return builder.build();
}

/* ---------- page helpers ---------- */
const $ = sel => driver.findElement(By.css(sel));

async function openApp() {
  await driver.get(BASE);
  // init() has finished once the Students tab shows its first real row or the empty message
  await driver.wait(async () => (await rows('#studentTable')).length > 0, WAIT, 'page did not load');
}
async function tab(name) {
  await $('nav button[data-tab="' + name + '"]').click();
}
async function rows(tableSel) {
  return driver.executeScript(`
    return Array.from(document.querySelectorAll(arguments[0] + ' tbody tr'))
      .map(tr => Array.from(tr.children).map(td => td.textContent.trim()));
  `, tableSel);
}
async function waitRows(tableSel, count) {
  await driver.wait(async () => (await rows(tableSel)).length === count, WAIT,
    tableSel + ' should have ' + count + ' rows');
  return rows(tableSel);
}
async function setValue(sel, value, eventName) {
  await driver.executeScript(`
    const el = document.querySelector(arguments[0]);
    el.value = arguments[1];
    el.dispatchEvent(new Event(arguments[2], { bubbles: true }));
  `, sel, value, eventName);
}
const setDailyDate  = v => setValue('#attDate', v, 'change');
const setMonth      = (sel, v) => setValue(sel, v, 'change');
const setThreshold  = (sel, v) => setValue(sel, v, 'input');

async function clearToast() {
  await driver.executeScript(`
    const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast';`);
}
async function waitToast(text) {
  await driver.wait(async () => {
    const t = await $('#toast');
    return (await t.getAttribute('class')).includes('show') && (await t.getText()).includes(text);
  }, WAIT, 'expected a message containing "' + text + '"');
}
async function addStudent(roll, name, dept) {
  await $('#sRoll').clear(); await $('#sName').clear();
  if (roll) await $('#sRoll').sendKeys(roll);
  if (name) await $('#sName').sendKeys(name);
  if (dept !== undefined) { await $('#sDept').clear(); if (dept) await $('#sDept').sendKeys(dept); }
  await $('#sSubmit').click();
}
async function periodButtons(rowIndex) {
  return driver.findElements(By.css('#dailyTable tbody tr:nth-child(' + rowIndex + ') button.mark'));
}
async function dailyTotals(rowIndex) {
  const r = (await rows('#dailyTable'))[rowIndex - 1];
  return { present: r[9], absent: r[10] };
}
async function waitDailyReady(date) {
  await setDailyDate(date);
  await driver.wait(async () => {
    const info = await $('#dailyInfo').getText();
    return info.includes(date);
  }, WAIT, 'daily sheet for ' + date + ' did not load');
}
async function waitForDownload(name, timeoutMs = 15000) {
  const file = path.join(downloadDir, name);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file) && !fs.existsSync(file + '.crdownload')) return file;
    await sleep(250);
  }
  throw new Error('Download did not finish: ' + name);
}

/* =========================================================
   TESTS
   ========================================================= */
describe('Student Attendance Management System', function () {
  before(async function () {
    await waitForServer(30000);
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-dl-'));
    driver = await buildDriver();
  });

  after(async function () {
    if (driver) await driver.quit();
    if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  beforeEach(async function () {
    await resetData();
  });

  it('1. attendance page displays all registered students', async function () {
    await seedStudents();
    await openApp();
    await tab('daily');
    await waitDailyReady(DAY1);

    const list = await waitRows('#dailyTable', STUDENTS.length);
    assert.deepStrictEqual(list.map(r => r[0]), STUDENTS.map(s => s.roll));
    assert.deepStrictEqual(list.map(r => r[1]), STUDENTS.map(s => s.name));
  });

  it('2. attendance can be marked for all seven periods', async function () {
    await seedStudents([STUDENTS[0]]);
    await openApp();
    await tab('daily');
    await waitDailyReady(DAY1);
    await waitRows('#dailyTable', 1);

    let buttons = await periodButtons(1);
    assert.strictEqual(buttons.length, 7, 'P1 to P7 columns');
    for (const b of buttons) assert.strictEqual(await b.getText(), 'P');   // default: all present

    for (const b of buttons) await b.click();                              // mark each period absent
    buttons = await periodButtons(1);
    for (const b of buttons) assert.strictEqual(await b.getText(), 'A');
    assert.deepStrictEqual(await dailyTotals(1), { present: '0', absent: '7' });

    await $('#allPresent').click();
    buttons = await periodButtons(1);
    for (const b of buttons) assert.strictEqual(await b.getText(), 'P');
    assert.deepStrictEqual(await dailyTotals(1), { present: '7', absent: '0' });

    await $('#allAbsent').click();
    assert.deepStrictEqual(await dailyTotals(1), { present: '0', absent: '7' });
  });

  it('3. attendance is saved successfully for a selected date', async function () {
    await seedStudents();
    await openApp();
    await tab('daily');
    await waitDailyReady(DAY1);
    await waitRows('#dailyTable', STUDENTS.length);

    const asha = await periodButtons(1);
    await asha[2].click();                      // P3 absent
    await asha[6].click();                      // P7 absent

    await clearToast();
    await $('#saveAtt').click();
    await waitToast('saved for ' + DAY1);

    // stored on the server
    const saved = await api('GET', '/api/attendance/' + DAY1);
    assert.strictEqual(saved.exists, true);
    assert.deepStrictEqual(saved.records['101'], [1, 1, 0, 1, 1, 1, 0]);
    assert.deepStrictEqual(saved.records['102'], ALL);

    // and loaded back by the page after a fresh visit
    await openApp();
    await tab('daily');
    await waitDailyReady(DAY1);
    await waitRows('#dailyTable', STUDENTS.length);
    const again = await periodButtons(1);
    assert.strictEqual(await again[2].getText(), 'A');
    assert.strictEqual(await again[0].getText(), 'P');
    assert.ok((await $('#dailyInfo').getText()).includes('Existing records'));
  });

  it('4. missing or invalid student information is handled', async function () {
    await openApp();
    await waitRows('#studentTable', 1);        // "No students registered" row

    await clearToast();
    await addStudent('', '');
    await waitToast('required');

    await clearToast();
    await addStudent('105', '');
    await waitToast('required');

    await clearToast();
    await addStudent('', 'No Roll');
    await waitToast('required');

    await clearToast();
    await addStudent('   ', '   ');
    await waitToast('required');

    assert.strictEqual((await api('GET', '/api/students')).length, 0, 'nothing stored');

    // valid student works, duplicate roll is refused
    await clearToast();
    await addStudent('105', 'Valid Student');
    await waitToast('added');
    await clearToast();
    await addStudent('105', 'Someone Else');
    await waitToast('already exists');
    assert.strictEqual((await api('GET', '/api/students')).length, 1);
    assert.strictEqual((await waitRows('#studentTable', 1))[0][1], 'Valid Student');
  });

  it('5. duplicate attendance entries are prevented', async function () {
    await seedStudents();
    await openApp();
    await tab('daily');
    await waitDailyReady(DAY1);
    await waitRows('#dailyTable', STUDENTS.length);

    await clearToast();
    await $('#saveAtt').click();
    await waitToast('saved for ' + DAY1);

    // saving the same date again updates the existing records
    await (await periodButtons(1))[0].click();
    await clearToast();
    await $('#saveAtt').click();
    await waitToast('updated for ' + DAY1);

    await tab('records');
    const dates = await waitRows('#recDates', 1);
    assert.strictEqual(dates[0][0], DAY1);
    assert.strictEqual(dates[0][1], String(STUDENTS.length));                           // students
    assert.strictEqual(Number(dates[0][2]) + Number(dates[0][3]), STUDENTS.length * 7); // periods, not doubled

    const day = await api('GET', '/api/attendance/' + DAY1);
    assert.strictEqual(Object.keys(day.records).length, STUDENTS.length);
    assert.strictEqual(day.records['101'][0], 0, 'second save changed the value');
  });

  it('6. monthly attendance totals are calculated correctly', async function () {
    await seedStudents();
    await seedAttendance();
    await openApp();
    await tab('monthly');
    await setMonth('#monMonth', MONTH);
    await driver.wait(async () => (await $('#monSummary').getText()).includes('Days recorded: 2'), WAIT);

    const summary = await $('#monSummary').getText();
    assert.ok(summary.includes('Working periods: 14'), summary);
    assert.ok(summary.includes('Students: 4'), summary);

    const list = await waitRows('#monTable', STUDENTS.length);
    list.forEach(r => {
      const exp = EXPECTED[r[0]];
      assert.deepStrictEqual([r[2], r[3], r[4]], exp.slice(0, 3), 'attended / absent / total for ' + r[0]);
    });
  });

  it('7. attendance percentage is displayed correctly', async function () {
    await seedStudents();
    await seedAttendance();
    await openApp();
    await tab('monthly');
    await setMonth('#monMonth', MONTH);
    const list = await waitRows('#monTable', STUDENTS.length);
    await driver.wait(async () => (await rows('#monTable'))[0][5] !== '—', WAIT);

    (await rows('#monTable')).forEach(r => {
      assert.strictEqual(r[5], EXPECTED[r[0]][3], 'percentage for ' + r[0]);
    });
    assert.ok(list.length === 4);

    // a month with no records shows no percentage
    await setMonth('#monMonth', '2026-08');
    await driver.wait(async () => (await $('#monSummary').getText()).includes('Days recorded: 0'), WAIT);
    (await rows('#monTable')).forEach(r => {
      assert.strictEqual(r[5], '—');
      assert.strictEqual(r[6], 'No data');
    });
  });

  it('8. students below the attendance threshold are identified', async function () {
    await seedStudents();
    await seedAttendance();
    await openApp();
    await tab('monthly');
    await setMonth('#monMonth', MONTH);
    await driver.wait(async () => (await $('#monSummary').getText()).includes('Below 75%: 2'), WAIT);

    const low = async () => driver.executeScript(`
      return Array.from(document.querySelectorAll('#monTable tbody tr'))
        .filter(tr => tr.lastElementChild.classList.contains('low'))
        .map(tr => tr.children[0].textContent);`);

    assert.deepStrictEqual(await low(), ['103', '104']);          // 35.71% and 71.43%
    (await rows('#monTable')).forEach(r => assert.strictEqual(r[6], EXPECTED[r[0]][4]));

    await setThreshold('#monThreshold', '70');                     // 71.43% is now acceptable
    await driver.wait(async () => (await $('#monSummary').getText()).includes('Below 70%: 1'), WAIT);
    assert.deepStrictEqual(await low(), ['103']);

    await setThreshold('#monThreshold', '90');                     // 85.71% falls below 90
    await driver.wait(async () => (await $('#monSummary').getText()).includes('Below 90%: 3'), WAIT);
    assert.deepStrictEqual(await low(), ['102', '103', '104']);
  });

  it('9. the monthly report can be generated and exported as CSV', async function () {
    await seedStudents();
    await seedAttendance();
    await openApp();
    await tab('reports');
    await setMonth('#repMonth', MONTH);
    await driver.wait(async () => (await $('#repSummary').getText()).includes('Days recorded: 2'), WAIT);

    // student-wise report
    const report = await waitRows('#repTable', STUDENTS.length);
    report.forEach(r => {
      const exp = EXPECTED[r[0]];
      assert.deepStrictEqual([r[3], r[4], r[5], r[6], r[7]], exp, 'report row for ' + r[0]);
    });
    assert.ok((await $('#repSummary').getText()).includes('Students below 75%: 2'));

    // daily history, newest first
    const history = await waitRows('#histTable', 2);
    assert.deepStrictEqual(history.map(h => h[0]), [DAY2, DAY1]);
    assert.deepStrictEqual(history.map(h => h[1]), ['Wed', 'Tue']);

    // CSV export
    await clearToast();
    await $('#exportBtn').click();
    await waitToast('exported');
    const file = await waitForDownload('attendance_' + MONTH + '.csv');
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    assert.strictEqual(lines.length, STUDENTS.length + 1);
    assert.strictEqual(lines[0],
      '"Roll No","Student Name","Department","Attended","Absent","Total Periods","Percentage","Status"');
    assert.strictEqual(lines[1], '"101","Asha","CSE (AI & ML)","13","1","14","92.86","OK"');
    assert.strictEqual(lines[3], '"103","Meena","CSE (AI & ML)","5","9","14","35.71","LOW"');
  });

  it('10. saved records remain available after the application is restarted', async function () {
    const cmd = process.env.RESTART_CMD ||
      (process.env.TEST_CONTAINER ? 'docker restart ' + process.env.TEST_CONTAINER : '');
    if (!cmd) this.skip();   // set RESTART_CMD or TEST_CONTAINER to enable

    await seedStudents();
    await openApp();
    await tab('daily');
    await waitDailyReady(DAY1);
    await waitRows('#dailyTable', STUDENTS.length);
    await (await periodButtons(2))[4].click();          // Ravi, P5 absent
    await clearToast();
    await $('#saveAtt').click();
    await waitToast('saved for ' + DAY1);

    execSync(cmd, { stdio: 'inherit' });                // restart the application
    await sleep(500);
    await waitForServer();

    await openApp();
    assert.strictEqual((await waitRows('#studentTable', STUDENTS.length)).length, STUDENTS.length);

    await tab('records');
    const dates = await waitRows('#recDates', 1);
    assert.strictEqual(dates[0][0], DAY1);

    await tab('daily');
    await waitDailyReady(DAY1);
    await waitRows('#dailyTable', STUDENTS.length);
    assert.strictEqual(await (await periodButtons(2))[4].getText(), 'A');
    assert.strictEqual(await (await periodButtons(2))[3].getText(), 'P');

    await tab('monthly');
    await setMonth('#monMonth', MONTH);
    await driver.wait(async () => (await $('#monSummary').getText()).includes('Days recorded: 1'), WAIT);
    const ravi = (await waitRows('#monTable', STUDENTS.length))[1];
    assert.deepStrictEqual([ravi[2], ravi[3], ravi[4]], ['6', '1', '7']);
  });
});
