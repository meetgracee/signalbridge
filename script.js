// ---------- Settings ----------
const API = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  ? 'http://127.0.0.1:8000'
  : 'https://YOUR-API-NAME.onrender.com';
const G = 0.005; // ~500 m grid cell (privacy)
const $ = id => document.getElementById(id);

// ---------- Map ----------
const map = L.map('leafmap').setView([6.50, 3.40], 11);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19
}).addTo(map);

const cells = L.layerGroup().addTo(map);

function colorFor(rate) {
  if (rate > 0.5) return '#ff6fa5';
  if (rate > 0.25) return '#ffb59a';
  return '#c9b6ff';
}

async function loadCells() {
  try {
    const res = await fetch(API + '/api/aggregates');
    const data = await res.json();
    cells.clearLayers();
    data.forEach(c => {
      const color = colorFor(c.slow_rate);
      L.rectangle(
        [[c.lat - G / 2, c.lng - G / 2], [c.lat + G / 2, c.lng + G / 2]],
        { color: color, weight: 1, fillColor: color, fillOpacity: 0.6 }
      ).bindPopup(
        '<b>' + Math.round(c.slow_rate * 100) + '% slow reports</b><br>' +
        c.count + ' reports<br>Last updated ' + new Date(c.last).toLocaleString()
      ).addTo(cells);
    });
  } catch (e) {
    $('msg').textContent = 'Cannot reach the backend. Is uvicorn running?';
  }
}

// ---------- Report form ----------
let picked = null;
let pin = null;

function setPick(latlng) {
  picked = latlng;
  if (pin) pin.remove();
  pin = L.circleMarker(latlng, { radius: 9, color: '#2b1a40', fillColor: '#ff6fa5', fillOpacity: 0.9 }).addTo(map);
  $('msg').textContent = 'Location selected. Fill in the details and submit.';
}

map.on('click', e => setPick(e.latlng));

$('geo').onclick = () => {
  if (!navigator.geolocation) {
    $('msg').textContent = 'Your browser does not support location. Click the map instead.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      setPick(ll);
      map.setView(ll, 14);
    },
    () => { $('msg').textContent = 'Location blocked. Click the map instead.'; }
  );
};

$('send').onclick = async () => {
  if (!picked) {
    $('msg').textContent = 'Please choose a location first (click the map).';
    return;
  }
  try {
    await fetch(API + '/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: $('provider').value,
        issue: $('issue').value,
        lat: picked.lat,
        lng: picked.lng,
        download: parseFloat($('dl').value),
        latency: parseFloat($('lat').value)
      })
    });
    if (pin) pin.remove();
    picked = null;
    $('msg').textContent = 'Thank you! Report saved (location rounded to ~500 m).';
    loadAll();
  } catch (e) {
    $('msg').textContent = 'Could not save. Is the backend running?';
  }
};

// ---------- Hour chart (real data) ----------
async function loadHourly() {
  try {
    const data = await (await fetch(API + '/api/hourly')).json();
    $('bars').innerHTML = data.map(d => {
      const h = Math.max(4, d.slow_rate * 100);
      const peak = d.slow_rate > 0.5 ? 'peak' : '';
      return '<div class="' + peak + '" style="height:' + h + '%" data-tip="' +
        d.hour + ':00 · ' + Math.round(d.slow_rate * 100) + '% slow · ' + d.reports + ' reports">' +
        '<span>' + d.hour + '</span></div>';
    }).join('');
  } catch (e) { /* backend offline */ }
}

// ---------- Insights (real data) ----------
async function loadInsights() {
  try {
    const data = await (await fetch(API + '/api/insights')).json();
    $('insightList').innerHTML = data.length
      ? data.map(i =>
          '<div class="insight">' + i.message +
          '<small>' + i.lat + ', ' + i.lng + ' · ' + i.reports + ' reports · score ' + i.z + '</small></div>'
        ).join('')
      : '<p>No unusual patterns detected yet.</p>';
  } catch (e) { /* backend offline */ }
}

function loadAll() {
  loadCells();
  loadHourly();
  loadInsights();
}

loadAll();
// ---------- Real browser speed test ----------
const TEST = 'https://speed.cloudflare.com/__down?bytes=';

async function pingOnce() {
  const t = performance.now();
  await fetch(TEST + '0&r=' + Math.random(), { cache: 'no-store' });
  return performance.now() - t;
}

async function measureLatency() {
  const v = [];
  for (let i = 0; i < 9; i++) v.push(await pingOnce());
  v.shift(); // first request includes connection setup, so skip it
  const sorted = [...v].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let j = 0;
  for (let i = 1; i < v.length; i++) j += Math.abs(v[i] - v[i - 1]);
  return { latency: Math.round(median), jitter: Math.round(j / (v.length - 1)) };
}

async function measureDownload() {
  const res = await fetch(TEST + '10000000&r=' + Math.random(), { cache: 'no-store' });
  const reader = res.body.getReader();
  const start = performance.now();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (performance.now() - start > 8000) { reader.cancel(); break; } // stop after 8s on slow links
  }
  const secs = (performance.now() - start) / 1000;
  return (bytes * 8) / secs / 1e6; // Mbps
}

$('runtest').onclick = async () => {
  const btn = $('runtest');
  const out = $('speedout');
  btn.disabled = true;
  out.classList.remove('on');
  try {
    btn.textContent = 'Testing latency…';
    const { latency, jitter } = await measureLatency();
    btn.textContent = 'Testing download…';
    const dl = await measureDownload();

    $('dl').value = dl.toFixed(1);
    $('lat').value = latency;

    let verdict = 'Looks healthy.';
    if (dl < 5) verdict = 'Slow download. Worth reporting.';
    else if (latency > 150 || jitter > 50) verdict = 'Speed is OK, but the connection looks unstable.';

    out.innerHTML =
      '<div><b>' + dl.toFixed(1) + '</b><small>Mbps down</small></div>' +
      '<div><b>' + latency + '</b><small>ms latency</small></div>' +
      '<div><b>' + jitter + '</b><small>ms jitter</small></div>' +
      '<p class="speedmsg">' + verdict + ' Values were added to the form below.</p>';
    out.classList.add('on');
  } catch (e) {
    out.innerHTML = '<p class="speedmsg">Test failed. Check your internet, or an ad blocker may be blocking it.</p>';
    out.classList.add('on');
  }
  btn.textContent = '▶ Run speed test again';
  btn.disabled = false;
};
// ---------- Connection troubleshooter ----------
const ts = { step: 0, conn: '', dl: null, latency: null, jitter: null, freq: '' };

function tsProgress() {
  $('tsprog').innerHTML = [0, 1, 2, 3].map(i => '<span class="' + (i <= ts.step ? 'on' : '') + '"></span>').join('');
}

function tsOpts(key, list) {
  return '<div class="opts">' + list.map(o =>
    '<button type="button" class="opt" data-k="' + key + '" data-v="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>';
}

function tsRender() {
  tsProgress();
  const b = $('tsbody');

  if (ts.step === 0) {
    b.innerHTML = '<h3>1. Which connection are you using right now?</h3>' +
      '<p>The test measures whatever your device is currently connected to.</p>' +
      tsOpts('conn', [['wifi', '📶 Wi-Fi'], ['mobile', '📱 Mobile data']]);
  }

  if (ts.step === 1) {
    b.innerHTML = '<h3>2. Let\'s measure it</h3>' +
      '<p>This takes about 15 seconds and uses roughly 10 MB of data.</p>' +
      '<div id="tsresult"></div>' +
      '<div class="tsbtns"><button type="button" class="btn" id="tsrun">▶ Run test</button></div>';
    $('tsrun').onclick = tsRunTest;
  }

  if (ts.step === 2) {
    b.innerHTML = '<h3>3. How often does this happen?</h3>' +
      tsOpts('freq', [
        ['now', 'Only right now'],
        ['evening', 'Same time most days (e.g. evenings)'],
        ['always', 'All the time, every day'],
        ['place', 'Only in certain places']
      ]);
  }

  if (ts.step === 3) tsShowResult();
}

async function tsRunTest() {
  const btn = $('tsrun');
  btn.disabled = true;
  try {
    btn.textContent = 'Testing latency…';
    const l = await measureLatency();
    btn.textContent = 'Testing download…';
    const dl = await measureDownload();
    ts.dl = dl; ts.latency = l.latency; ts.jitter = l.jitter;
    $('tsresult').innerHTML = '<div class="tsnums">' +
      '<div><b>' + dl.toFixed(1) + '</b><small>Mbps down</small></div>' +
      '<div><b>' + l.latency + '</b><small>ms latency</small></div>' +
      '<div><b>' + l.jitter + '</b><small>ms jitter</small></div></div>';
    btn.parentElement.innerHTML = '<button type="button" class="btn" id="tsnext">Continue →</button>';
    $('tsnext').onclick = () => { ts.step = 2; tsRender(); };
  } catch (e) {
    $('tsresult').innerHTML = '<p class="tsnote">The test failed. Check your internet or turn off any ad blocker, then try again.</p>';
    btn.disabled = false;
    btn.textContent = '▶ Try again';
  }
}

function tsTips() {
  const slow = ts.dl < 5;
  const unstable = ts.latency > 150 || ts.jitter > 50;
  const t = [];

  if (!slow && !unstable) {
    t.push('Your connection looks healthy right now, so the problem may be intermittent. Note the times it happens and test again then.');
  }
  if (slow && ts.conn === 'wifi') {
    t.push('On Wi-Fi, slow speeds can come from distance to the router, walls, interference or many devices sharing it. Try moving closer and restarting the router.');
    t.push('To compare, turn off Wi-Fi and test again on mobile data. If mobile is much faster, the Wi-Fi setup is a likely suspect.');
  }
  if (slow && ts.conn === 'mobile') {
    t.push('On mobile data, slow speeds can come from a weak signal indoors, a busy network, or a plan limit that slows you after heavy use. Try near a window or outdoors.');
    t.push('To compare, test on Wi-Fi too. If Wi-Fi is fast, your mobile connection is the one to watch.');
  }
  if (unstable) {
    t.push('High latency or jitter means the connection is unstable, which hurts calls and video even when speed looks fine. A weak signal or interference are possible reasons.');
  }
  if (ts.freq === 'evening') {
    t.push('Slow at the same hours daily is a classic pattern of busy-hour congestion. We can\'t see network load, so this is a possible explanation, not a confirmed one. Reporting helps show whether others see it too.');
  }
  if (ts.freq === 'always') {
    t.push('If it\'s slow all the time, check your data plan limits, try another device, and check that your SIM or router isn\'t the issue.');
  }
  if (ts.freq === 'place') {
    t.push('Slow only in some places points to local coverage or building materials. Note exactly where it\'s good and where it\'s bad.');
  }
  return t;
}

function tsShowResult() {
  const tips = tsTips();
  $('tsbody').innerHTML = '<h3>4. What this could mean</h3>' +
    '<div class="tsnums">' +
    '<div><b>' + ts.dl.toFixed(1) + '</b><small>Mbps down</small></div>' +
    '<div><b>' + ts.latency + '</b><small>ms latency</small></div>' +
    '<div><b>' + ts.jitter + '</b><small>ms jitter</small></div></div>' +
    '<ul class="tips">' + tips.map(x => '<li>' + x + '</li>').join('') + '</ul>' +
    '<p class="tsnote">These are possible explanations based on what a browser can measure. We can\'t see your signal strength or your network\'s towers, so this isn\'t a diagnosis.</p>' +
    '<div id="tsnearby"></div>' +
    '<div class="tsbtns">' +
    '<button type="button" class="btn ghost" id="tsnb">Is it just me? Check nearby</button>' +
    '<button type="button" class="btn" id="tsreport">Use these numbers in a report</button>' +
    '<button type="button" class="btn ghost" id="tsagain">Start over</button></div>';

  $('tsnb').onclick = tsNearby;
  $('tsagain').onclick = () => { ts.step = 0; tsRender(); };
  $('tsreport').onclick = () => {
    $('dl').value = ts.dl.toFixed(1);
    $('lat').value = ts.latency;
    document.getElementById('map').scrollIntoView();
    $('msg').textContent = 'Numbers filled in. Click the map to choose your location, then submit.';
  };
}

function tsNearby() {
  const out = $('tsnearby');
  if (!navigator.geolocation) { out.innerHTML = '<p class="tsnote">Your browser can\'t share location.</p>'; return; }
  out.innerHTML = '<p class="tsnote">Checking…</p>';
  navigator.geolocation.getCurrentPosition(async pos => {
    try {
      const url = API + '/api/nearby?lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude;
      const d = await (await fetch(url)).json();
      let msg;
      if (d.reports < 5) {
        msg = 'Not enough reports near you yet to say. Submitting yours helps build the picture.';
      } else if (d.slow / d.reports >= 0.4) {
        msg = d.slow + ' of ' + d.reports + ' reports within about 1 km in the last 3 days were slow. This looks widespread, not just your connection.';
      } else {
        msg = 'Only ' + d.slow + ' of ' + d.reports + ' nearby reports were slow. The problem may be specific to your connection or spot.';
      }
      out.innerHTML = '<p class="tsnote">' + msg + '</p>';
    } catch (e) {
      out.innerHTML = '<p class="tsnote">Could not reach the backend. Is uvicorn running?</p>';
    }
  }, () => { out.innerHTML = '<p class="tsnote">Location blocked. Allow it in your browser to use this check.</p>'; });
}

$('tsbody').addEventListener('click', e => {
  const o = e.target.closest('.opt');
  if (!o) return;
  ts[o.dataset.k] = o.dataset.v;
  ts.step++;
  tsRender();
});

tsRender();

fetch(API + '/api/stats').then(r => r.json()).then(s => {
  $('st-reports').textContent = s.reports.toLocaleString();
  $('st-cells').textContent = s.cells;
}).catch(() => {});