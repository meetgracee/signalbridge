const API = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  ? 'http://127.0.0.1:8000'
  : 'https://YOUR-API-NAME.onrender.com';
const $ = id => document.getElementById(id);

// ---------- Auth ----------
const token = localStorage.getItem('sb_token');
if (!token) location.href = 'login.html';
const user = JSON.parse(localStorage.getItem('sb_user') || '{}');
$('who').textContent = (user.name || '') + ' · ' + (user.role || '');

// Escape anything typed by users before putting it on the page
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
  });
  if (res.status === 401) { localStorage.clear(); location.href = 'login.html'; throw new Error('auth'); }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || 'Request failed');
  }
  return res;
}

$('logout').onclick = async e => {
  e.preventDefault();
  try { await api('/api/logout', { method: 'POST' }); } catch (x) {}
  localStorage.clear();
  location.href = 'login.html';
};

// ---------- Dashboard ----------
function query() {
  const p = new URLSearchParams();
  [['area', 'f-area'], ['provider', 'f-provider'], ['days', 'f-days'], ['issue', 'f-issue']]
    .forEach(([key, id]) => { const v = $(id).value; if (v) p.set(key, v); });
  return p.toString();
}

async function load() {
  try {
    const d = await (await api('/api/dashboard?' + query())).json();
    $('err').textContent = '';

    $('k-reports').textContent = d.kpis.reports.toLocaleString();
    $('k-slow').textContent = Math.round(d.kpis.slow_rate * 100) + '%';
    $('k-dl').textContent = d.kpis.avg_download + ' Mbps';
    $('k-lat').textContent = d.kpis.avg_latency + ' ms';

    $('bars').innerHTML = d.hourly.map(x => {
      const h = Math.max(4, x.slow_rate * 100);
      return '<div class="' + (x.slow_rate > 0.5 ? 'peak' : '') + '" style="height:' + h + '%" data-tip="' +
        x.hour + ':00 · ' + Math.round(x.slow_rate * 100) + '% slow · ' + x.reports + ' reports">' +
        '<span>' + x.hour + '</span></div>';
    }).join('');

    $('trend').innerHTML =
      '<div><small>Earlier half</small><b>' + Math.round(d.trend.earlier * 100) + '% slow</b></div>' +
      '<span>→</span>' +
      '<div><small>Recent half</small><b>' + Math.round(d.trend.recent * 100) + '% slow</b></div>';

    const maxDl = Math.max(1, ...d.providers.map(p => p.avg_download));
    $('providers').innerHTML = d.providers.map(p =>
      '<div class="bar"><label>' + esc(p.provider) + ' · ' + p.avg_download + ' Mbps · ' +
      Math.round(p.slow_rate * 100) + '% slow</label><i style="--w:' +
      (p.avg_download / maxDl * 100) + '%"></i></div>').join('');

    const cls = { Investigate: 'hot', Monitor: '', Normal: 'ok' };
    $('areas').innerHTML = d.areas.length
      ? d.areas.map(a =>
          '<tr><td>' + esc(a.area) + '</td><td>' + esc(a.peak) + '</td><td>' + a.reports +
          '</td><td>' + Math.round(a.slow_rate * 100) + '%</td><td><span class="tag ' +
          cls[a.status] + '">' + a.status + '</span></td><td>' +
          (a.status !== 'Normal'
            ? '<button class="btn small" type="button" data-case="' + esc(a.area) + '" data-peak="' + esc(a.peak) + '">Open case</button>'
            : '') + '</td></tr>').join('')
      : '<tr><td colspan="6">Not enough reports for these filters (minimum 5 per area).</td></tr>';
  } catch (e) {
    if (e.message !== 'auth') $('err').textContent = 'Cannot load data: ' + e.message;
  }
}

['f-area', 'f-provider', 'f-days', 'f-issue'].forEach(id => $(id).onchange = load);

$('export').onclick = async () => {
  try {
    const res = await api('/api/export.csv?' + query());
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'signalbridge_export.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { if (e.message !== 'auth') alert(e.message); }
};

// ---------- Case tracker ----------
let ncArea = '';

$('areas').addEventListener('click', e => {
  const b = e.target.closest('[data-case]');
  if (!b) return;
  ncArea = b.dataset.case;
  $('nc-area').textContent = ncArea;
  $('nc-title').value = ncArea + ': recurring slow reports' + (b.dataset.peak !== '·' ? ' ' + b.dataset.peak : '');
  $('newcase').hidden = false;
  $('newcase').scrollIntoView({ behavior: 'smooth' });
});

$('nc-cancel').onclick = () => { $('newcase').hidden = true; };

$('nc-save').onclick = async () => {
  try {
    await api('/api/cases', {
      method: 'POST',
      body: JSON.stringify({
        title: $('nc-title').value,
        area: ncArea,
        provider: $('f-provider').value || null,
        priority: $('nc-prio').value,
        note: $('nc-note').value
      })
    });
    $('newcase').hidden = true;
    $('nc-note').value = '';
    loadCases();
  } catch (e) { if (e.message !== 'auth') alert(e.message); }
};

// ---------- Cases with before / after comparison ----------
const localToday = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const pct = x => Math.round(x * 100) + '%';

function renderCompare(d) {
  const row = (label, b, a) =>
    '<div class="cmp"><small>' + label + '</small><div class="ba">' +
    '<div><small>Before</small><b>' + pct(b.slow_rate) + ' slow</b><small>' + b.reports + ' reports · ' + b.avg_download + ' Mbps avg</small></div>' +
    '<span>→</span>' +
    '<div><small>After</small><b>' + pct(a.slow_rate) + ' slow</b><small>' + a.reports + ' reports · ' + a.avg_download + ' Mbps avg</small></div>' +
    '</div></div>';
  return '<div class="verdict ' + d.verdict + '">' + esc(d.message) + '</div>' +
    row('Whole area', d.overall.before, d.overall.after) +
    (d.peak ? row('Peak hours ' + esc(d.peak.hours), d.peak.before, d.peak.after) : '') +
    '<p class="mono small">' + esc(d.window) + (d.note ? '<br>Change made: ' + esc(d.note) : '') +
    '<br>' + esc(d.caveat) + '</p>';
}

async function runCompare(box) {
  const out = box.querySelector('.cresult');
  out.innerHTML = '<p class="mono small">Comparing…</p>';
  try {
    const d = await (await api('/api/cases/' + box.dataset.id + '/compare')).json();
    out.innerHTML = renderCompare(d);
  } catch (e) {
    if (e.message !== 'auth') out.innerHTML = '<div class="verdict unclear">' + esc(e.message) + '</div>';
  }
}

async function loadCases() {
  try {
    const list = await (await api('/api/cases')).json();
    const today = localToday();
    $('cases').innerHTML = list.length ? list.map(c => {
      const hasInt = !!c.intervention_at;
      return '<div class="case" data-id="' + c.id + '">' +
        '<div class="casehead"><b>' + esc(c.title) + '</b><span class="tag ' +
        (c.priority === 'high' ? 'hot' : '') + '">' + esc(c.priority) + '</span></div>' +
        '<small class="mono">' + esc(c.area) + (c.provider ? ' · ' + esc(c.provider) : '') +
        ' · opened by ' + esc(c.created_by) + ' · updated ' + new Date(c.updated_at).toLocaleString() + '</small>' +
        '<textarea class="cnote">' + esc(c.note) + '</textarea>' +
        '<div class="caseact"><select class="cstatus">' +
        ['Open', 'Investigating', 'Resolved'].map(s =>
          '<option' + (s === c.status ? ' selected' : '') + '>' + s + '</option>').join('') +
        '</select><button class="btn small csave" type="button">Save</button></div>' +
        '<div class="interv"><b>Intervention</b>' +
        '<div class="caseact"><input type="date" class="cdate" max="' + today + '" value="' +
        (hasInt ? esc(c.intervention_at.slice(0, 10)) : '') + '">' +
        '<input class="cintnote" placeholder="What was changed? e.g. capacity upgrade" value="' + esc(c.intervention_note) + '">' +
        '<button class="btn small ghost cint" type="button">Save</button></div>' +
        (hasInt
          ? '<div class="caseact"><button class="btn small ccompare" type="button">Compare before / after</button>' +
            (user.role === 'manager' ? '<button class="btn small ghost cdemo" type="button">Generate demo improvement</button>' : '') +
            '</div>'
          : '<p class="mono small">Set the date the fix was made to unlock the comparison.</p>') +
        '<div class="cresult"></div></div></div>';
    }).join('') : '<p class="mono small">No cases yet.</p>';
  } catch (e) { /* handled in api() */ }
}

$('cases').addEventListener('click', async e => {
  const t = e.target;
  const box = t.closest('.case');
  if (!box) return;
  const id = box.dataset.id;
  try {
    if (t.classList.contains('csave')) {
      await api('/api/cases/' + id, {
        method: 'PATCH',
        body: JSON.stringify({
          status: box.querySelector('.cstatus').value,
          note: box.querySelector('.cnote').value
        })
      });
      loadCases();
    } else if (t.classList.contains('cint')) {
      const date = box.querySelector('.cdate').value;
      if (!date) { alert('Pick the date the change was made.'); return; }
      await api('/api/cases/' + id + '/intervention', {
        method: 'POST',
        body: JSON.stringify({ date: date, note: box.querySelector('.cintnote').value })
      });
      await loadCases();
    } else if (t.classList.contains('ccompare')) {
      runCompare(box);
    } else if (t.classList.contains('cdemo')) {
      if (!confirm('DEMO ONLY: this replaces this area\'s reports after the intervention date with synthetic improved data. Continue?')) return;
      await api('/api/cases/' + id + '/demo-improvement', { method: 'POST' });
      await loadCases();
      const nb = document.querySelector('.case[data-id="' + id + '"]');
      if (nb) runCompare(nb);
    }
  } catch (err) { if (err.message !== 'auth') alert(err.message); }
});

load();
loadCases();