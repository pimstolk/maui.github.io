import { fmt, gaugePct, stageLabel } from './format.js?v=ce5aaf13';
import { meldingBestanden } from './stem.js';

// Data source: 'local' (served by the Pi, uses /ws) or 'cloud' (GitHub Pages,
// reads a public Adafruit IO feed). config.js sets window.RENOGY_CONFIG.
const CFG = (typeof window !== 'undefined' && window.RENOGY_CONFIG) || { mode: 'local' };

let _lastAis = [];          // latest AIS targets (for the radar map)
let _self = null;           // our own {lat, lon, heading_deg}
let _aisMapOpen = false;
let _settings = null;       // user settings from /api/settings
let _ackMmsi = new Set();   // acknowledged threats (muted while still in zone)
let _snoozeUntil = 0;       // epoch ms; all alarms muted until then
let _lastBeep = 0;
let _spreekt = false;       // een melding loopt; er mag er geen tweede overheen
let _saveTimer = 0;
let _audioCtx = null;

const U = (v, unit, d = 1) => `${fmt(v, unit, d)}<small>${unit}</small>`;

// Pure-ish: takes a document and a setGauge fn so it is unit-testable in node.
export function applyReading(r, doc = document, setGauge = defaultSetGauge) {
  const set = (id, html) => { const e = doc.getElementById(id); if (e) e.innerHTML = html; };
  const text = (id, t) => { const e = doc.getElementById(id); if (e) e.textContent = t; };

  set('soc', r.soc == null ? '–' : String(Math.round(r.soc)));
  set('battV', U(r.battery_voltage, 'V', 1));
  set('battA', U(r.charge_current, 'A', 1));
  set('battT', U(r.battery_temp, '°C', 0));

  set('pvPower', r.pv_power == null ? '–' : String(Math.round(r.pv_power)));
  set('pvV', U(r.pv_voltage, 'V', 1));
  set('pvA', U(r.pv_current, 'A', 1));

  set('altPower', r.alt_power == null ? '–' : String(Math.round(r.alt_power)));
  set('altV', U(r.alt_voltage, 'V', 1));
  set('altA', U(r.alt_current, 'A', 1));

  if (r.ah_today != null) set('ahToday', U(r.ah_today, 'Ah', 1));
  if (r.wh_today != null) set('whToday', U(r.wh_today, 'Wh', 0));
  if (r.peak_power_today != null) set('peakW', U(r.peak_power_today, 'W', 0));
  if (r.batt_max_v_today != null) set('maxV', U(r.batt_max_v_today, 'V', 1));

  text('stageName', stageLabel(r.charge_status));
  text('fPv', `${r.pv_power == null ? '–' : Math.round(r.pv_power)} W`);
  text('fComb', `${fmt(r.charge_current, 'A', 1)} A`);

  setGauge('battery', gaugePct(r.soc, 100));
  setGauge('solar', gaugePct(r.pv_power, 360));
  setGauge('alt', gaugePct(r.alt_power, 600));
}

// Combined solar: the "Zon (totaal)" hero = Renogy PV + every Victron MPPT.
// victron is a {name: {solar_power, battery_voltage, ...}} map; totalSolar comes
// from the backend so both sides agree.
export function applyVictron(victron, totalSolar, doc = document) {
  const set = (id, html) => { const e = doc.getElementById(id); if (e) e.innerHTML = html; };
  const width = (id, pct) => { const e = doc.getElementById(id); if (e && e.style) e.style.width = pct + '%'; };
  let vic = 0;
  for (const d of Object.values(victron || {})) if (d && d.solar_power) vic += d.solar_power;
  const total = totalSolar == null ? 0 : totalSolar;
  set('totalSolar', totalSolar == null ? '–' : String(Math.round(totalSolar)));
  set('vicSolar', String(Math.round(vic)));
  // proportion bar: split the total between Renogy and Victron
  const denom = total > 0 ? total : 1;
  width('victronBar', Math.round((vic / denom) * 100));
  width('renogyBar', Math.round((Math.max(0, total - vic) / denom) * 100));
}

function defaultSetGauge(name, pct) {
  const Circ = 2 * Math.PI * 86;
  const arc = document.querySelector(`[data-color=${name}] .arc`);
  if (arc) arc.style.strokeDashoffset = Circ * (1 - pct);
}

// go2rtc WebRTC player URL for the Camera tab. Built from the page's own host so
// it works on the boat TV (localhost) and for remote viewers (Pi LAN ip) alike.
export function cameraStreamUrl(hostname, { port = 1984, src = 'boatcam' } = {}) {
  return `http://${hostname}:${port}/webrtc.html?src=${src}`;
}
// expose to the inline tab-wiring script (evaluated at click-time, after this module loads)
if (typeof window !== 'undefined') window.cameraStreamUrl = cameraStreamUrl;

// PTZ control: press starts a continuous move, release stops it. A quick tap =
// a short move (nudge); a hold = a sweep. A safety timer stops the camera if a
// release event is ever missed (finger slides off the button). `post(move)`
// performs the request; timer fns are injectable for tests.
export function makePtzController(post, { safetyMs = 4000,
    setTimer = (typeof setTimeout !== 'undefined' ? setTimeout : null),
    clearTimer = (typeof clearTimeout !== 'undefined' ? clearTimeout : null) } = {}) {
  let timer = null;
  const clear = () => { if (timer != null) { clearTimer(timer); timer = null; } };
  return {
    press(move) {
      clear();
      post(move);
      timer = setTimer(() => { timer = null; post('stop'); }, safetyMs);
    },
    release() { clear(); post('stop'); },
  };
}
if (typeof window !== 'undefined') window.makePtzController = makePtzController;

// --- AIS collision alarm (pure decision logic; driven by the settings) ---
// A target trips the alarm if it's inside the safety radius OR on a collision
// course (closest approach under the CPA limit and arriving within the TCPA limit).
export function alarmReason(t, s) {
  if (t.dist_nm != null && t.dist_nm <= s.alarm_radius_nm) return 'radius';
  if (t.cpa_nm != null && t.tcpa_min != null &&
      t.cpa_nm < s.alarm_cpa_nm && t.tcpa_min >= 0 && t.tcpa_min < s.alarm_tcpa_min)
    return 'collision';
  return null;
}
// Evaluate the whole target list against the settings + alarm state (ack/snooze).
// Returns the threat list (for the banner/highlighting) and whether to sound.
export function evaluateAlarms(ships, s, { ackMmsi = new Set(), snoozeUntil = 0, now = 0 } = {}) {
  if (!s || !s.alarm_enabled) return { threats: [], sound: false, snoozed: false };
  const threats = [];
  for (const t of (ships || [])) {
    const reason = alarmReason(t, s);
    if (reason) threats.push({ ...t, reason });
  }
  const snoozed = now < snoozeUntil;
  const hasUnacked = threats.some(t => !ackMmsi.has(t.mmsi));
  return { threats, snoozed, sound: !snoozed && hasUnacked };
}
if (typeof window !== 'undefined') { window.alarmReason = alarmReason; window.evaluateAlarms = evaluateAlarms; }

// ---- boat instruments (NMEA 2000 via SignalK) ----
export function windLabel(awaDeg) {
  if (awaDeg == null) return '—';
  const side = awaDeg >= 0 ? 'SB' : 'BB';          // stuurboord / bakboord
  return `${Math.abs(Math.round(awaDeg))}° ${side}`;
}

export function applyBoat(b, doc = document) {
  if (!b) return;
  const set = (id, html) => { const e = doc.getElementById(id); if (e) e.innerHTML = html; };
  const u = (v, unit, d = 1) => (v == null ? '–' : `${Number(v).toFixed(d)}<small>${unit}</small>`);

  set('aws', b.aws_kn == null ? '–' : Number(b.aws_kn).toFixed(1));
  set('awsNow', b.aws_kn == null ? '–' : Number(b.aws_kn).toFixed(1));
  set('awaLabel', windLabel(b.awa_deg));
  set('hdg', b.heading_deg == null ? '–' : `${Math.round(b.heading_deg)}°`);
  set('stw', u(b.stw_kn, 'kn', 1));
  set('sog', u(b.sog_kn, 'kn', 1));
  set('depth', b.depth_m == null ? '–' : `${Number(b.depth_m).toFixed(1)}<small>m</small>`);
  set('rudder', b.rudder_deg == null ? '–' : `${Math.round(b.rudder_deg)}°`);
  set('rot', b.rot_deg_min == null ? '–' : `${Math.round(b.rot_deg_min)}<small>°/min</small>`);
  set('engTemp', u(b.engineroom_c, '°C', 0));
  set('exhTemp', u(b.exhaust_c, '°C', 0));
  set('logNm', b.log_nm == null ? '–' : `${Math.round(b.log_nm)}<small>nm</small>`);
  set('cog', b.cog_deg == null ? '–' : `${Math.round(b.cog_deg)}°`);

  // expose GPS position for the weather buttons + AIS radar (fallback if absent)
  if (b.lat != null && b.lon != null) {
    _self = { lat: b.lat, lon: b.lon, heading_deg: b.heading_deg };
    if (typeof window !== 'undefined') window.__latlon = [b.lat, b.lon];
  }

  const card = doc.getElementById('compassCard');
  if (card && b.heading_deg != null) card.style.transform = `rotate(${-b.heading_deg}deg)`;
  const arrow = doc.getElementById('windArrow');
  if (arrow && b.awa_deg != null) {
    arrow.style.transform = `rotate(${b.awa_deg}deg)`;
    arrow.style.color = b.awa_deg >= 0 ? '#2bd576' : '#ff5d63';
  }
  const dt = doc.getElementById('depthTile');
  if (dt && dt.classList) dt.classList.toggle('warn', b.depth_m != null && b.depth_m < 1.0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Nearby AIS ships: list of {name, dist_nm, sog_kn?, cog_deg?}. Top-10 table.
export function renderAis(list, doc = document, threatMmsi = null) {
  const el = doc.getElementById('aisTable');
  if (!el) return;
  if (!list || !list.length) {
    el.innerHTML = '<div class="ais-empty">geen schepen</div>';
    return;
  }
  const threats = threatMmsi || new Set();
  el.innerHTML = list.slice(0, 20).map((s, i) => {
    const sog = s.sog_kn == null ? '–' : `${Number(s.sog_kn).toFixed(1)} kn`;
    const cog = s.cog_deg == null ? '–'
      : `${String(Math.round(s.cog_deg) % 360).padStart(3, '0')}°`;
    // one row: metrics stay in columns; only the name may wrap (up to 2 lines).
    // A ship that trips the alarm gets .ais-threat; tapping it acknowledges it.
    const cls = threats.has(s.mmsi) ? 'ais-row ais-threat' : 'ais-row';
    return `<div class="${cls}" data-mmsi="${s.mmsi == null ? '' : s.mmsi}">` +
      `<span class="ais-rank">${i + 1}</span>` +
      `<span class="ais-n">${escapeHtml(s.name)}</span>` +
      `<span class="ais-sog">${sog}</span>` +
      `<span class="ais-cog">${cog}</span>` +
      `<span class="ais-d">${Number(s.dist_nm).toFixed(2)} NM</span></div>`;
  }).join('');
}

// ---- AIS radar map (self-rendered from our bus AIS; no internet needed) ----
function niceCeilRange(nm) {
  for (const s of [0.25, 0.5, 1, 2, 3, 5, 10, 20]) if (nm <= s) return s;
  return Math.ceil(nm / 10) * 10;
}

export function aisMapSvg(ais, self, size = 620) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 34;
  if (!self || self.lat == null || self.lon == null) {
    return `<text x="${cx}" y="${cy}" fill="#7c8ba0" font-size="16" text-anchor="middle">geen GPS-positie</text>`;
  }
  const ships = (ais || []).filter(s => s.lat != null && s.lon != null);
  let maxR = 0.25;
  ships.forEach(s => { maxR = Math.max(maxR, s.dist_nm || 0); });
  maxR = niceCeilRange(maxR);
  const coslat = Math.cos(self.lat * Math.PI / 180);
  const proj = (lat, lon) => [
    cx + ((lon - self.lon) * coslat * 60 / maxR) * R,
    cy - ((lat - self.lat) * 60 / maxR) * R,
  ];
  let svg = '';
  for (let k = 1; k <= 4; k++) {
    const rr = R * k / 4, lbl = maxR * k / 4;
    svg += `<circle cx="${cx}" cy="${cy}" r="${rr.toFixed(1)}" class="rr"/>`;
    svg += `<text x="${cx + 5}" y="${(cy - rr + 14).toFixed(1)}" class="rrl">${lbl < 1 ? lbl.toFixed(2) : lbl.toFixed(1)} NM</text>`;
  }
  svg += `<text x="${cx}" y="20" class="card-n2">N</text>`;
  svg += `<text x="${size - 13}" y="${cy + 5}" class="card-c2">O</text>`;
  svg += `<text x="${cx}" y="${size - 6}" class="card-c2">Z</text>`;
  svg += `<text x="11" y="${cy + 5}" class="card-c2">W</text>`;
  ships.forEach((s, i) => {
    const [x, y] = proj(s.lat, s.lon);
    if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) return;   // clip to plot
    if (s.cog_deg != null && (s.sog_kn || 0) > 0.3) {
      const r = s.cog_deg * Math.PI / 180;
      svg += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 12 * Math.sin(r)).toFixed(1)}" y2="${(y - 12 * Math.cos(r)).toFixed(1)}" class="shv"/>`;
    }
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.6" class="sh"/>`;
    if (i < 14) svg += `<text x="${(x + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" class="shl">${escapeHtml(s.name)}</text>`;
  });
  const hd = self.heading_deg || 0;
  svg += `<g transform="rotate(${hd} ${cx} ${cy})"><path d="M${cx} ${cy - 11} l7 18 h-14 z" class="selfm"/></g>`;
  return svg;
}

function renderAisMap(doc = document) {
  const el = doc.getElementById('aisMap');
  if (el) el.innerHTML = aisMapSvg(_lastAis, _self);
}

// wind-speed sparkline over the last ~30 min (from /api/wind: [[ts, aws_kn], ...])
function renderWind(points) {
  const svg = document.getElementById('windTrend');
  const setTxt = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  if (!svg) return;
  if (!points || points.length < 2) { svg.innerHTML = ''; return; }
  const vals = points.map(p => p[1] || 0);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  setTxt('windMin', vmin.toFixed(1));
  setTxt('windMax', vmax.toFixed(1));
  const W = 300, H = 150;
  let max = Math.max(5, vmax); max = Math.ceil(max / 5) * 5;
  setTxt('windAxTop', String(max));
  setTxt('windAxMid', String(max / 2));
  const t0 = points[0][0], span = (points[points.length - 1][0] - t0) || 1;
  const y = v => H - 6 - (v / max) * (H - 18);
  const xy = points.map(p => [((p[0] - t0) / span) * W, y(p[1] || 0)]);
  const line = xy.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
  const grid = [max / 2, max].map(v =>
    `<line x1="0" y1="${y(v).toFixed(1)}" x2="${W}" y2="${y(v).toFixed(1)}" class="wgrid"/>`).join('');
  svg.innerHTML =
    `<defs><linearGradient id="gWind" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#6fd6ff" stop-opacity=".34"/><stop offset="1" stop-color="#6fd6ff" stop-opacity="0"/></linearGradient></defs>` +
    grid +
    `<path d="${line} L ${W} ${H} L 0 ${H} Z" fill="url(#gWind)"/>` +
    `<path d="${line}" fill="none" stroke="#6fd6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
}

async function refreshWind() {
  try {
    const res = await fetch('/api/wind');
    const { wind } = await res.json();
    renderWind(wind);
  } catch (e) { /* keep last chart */ }
}

// Pure helper for the 24h trend chart — unit-tested in node.
export function seriesToPath(points, key, { w, h, min, max }) {
  if (!points.length) return '';
  const span = (max - min) || 1;
  const n = points.length - 1 || 1;
  return points.map((p, i) => {
    const x = (i / n) * w;
    const y = h - 10 - ((p[key] - min) / span) * (h - 20);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function renderChart(series) {
  const svg = document.getElementById('trend');
  if (!svg || !series.length) return;
  let max = 50;
  series.forEach(p => { max = Math.max(max, p.pv_power || 0, p.alt_power || 0); });
  const dims = { w: 600, h: 118, min: 0, max: Math.ceil(max / 50) * 50 };
  const pv = seriesToPath(series, 'pv_power', dims);
  const alt = seriesToPath(series, 'alt_power', dims);
  const area = p => (p ? `${p} L ${dims.w} ${dims.h} L 0 ${dims.h} Z` : '');
  svg.innerHTML = `
    <defs>
      <linearGradient id="gPv" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffc24b" stop-opacity=".30"/><stop offset="1" stop-color="#ffc24b" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="gAlt" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#49b6ff" stop-opacity=".28"/><stop offset="1" stop-color="#49b6ff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area(alt)}" fill="url(#gAlt)"/>
    <path d="${area(pv)}" fill="url(#gPv)"/>
    <path d="${alt}" fill="none" stroke="#49b6ff" stroke-width="2" stroke-linecap="round"/>
    <path d="${pv}" fill="none" stroke="#ffc24b" stroke-width="2.5" stroke-linecap="round"/>`;
}

// ---- Adafruit IO (cloud) parsing — pure, unit-tested in node ----
const AIO_BASE = 'https://io.adafruit.com/api/v2';

export function parseAioValue(value) {
  return JSON.parse(value);            // our compact snapshot JSON
}

export function aioHistoryToSeries(items) {
  // AIO returns data newest-first; chart wants chronological order.
  return items
    .map((it) => {
      let v;
      try { v = JSON.parse(it.value); } catch (e) { return null; }
      return {
        t: Math.floor(new Date(it.created_at).getTime() / 1000),
        soc: v.soc, pv_power: v.pv_power, alt_power: v.alt_power,
      };
    })
    .filter(Boolean)
    .reverse();
}

// Eén publieke aanroep naar /feeds levert alle feeds mét last_value. Daaruit
// stellen we hetzelfde reading- en boat-object samen als de Pi over de websocket
// stuurt, zodat applyReading/applyBoat hier ongewijzigd op werken.
const AIO_SOLAR = {
  soc: 'soc',
  battery_voltage: 'battery-voltage',
  charge_current: 'charge-current',
  battery_temp: 'battery-temp',
  pv_power: 'pv-power',
  alt_power: 'alt-power',
  ah_today: 'ah-today',
};

export function aioFeedsToState(feeds) {
  const byKey = {};
  (feeds || []).forEach((f) => { if (f && f.key) byKey[f.key] = f; });

  const num = (key) => {
    const f = byKey[key];
    const raw = f && f.last_value;
    if (raw == null || raw === '') return null;   // nooit 0 verzinnen voor "onbekend"
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const reading = {};
  Object.entries(AIO_SOLAR).forEach(([veld, key]) => { reading[veld] = num(key); });

  // De extra-feed draagt de laderwaarden die geen eigen feed hebben (dynamo-volt
  // en -ampère, Wh vandaag, piekvermogen, laadfase). Zonder deze aanvulling toont
  // het dashboard daar streepjes. De sleutels overlappen niet met de losse feeds.
  const extra = byKey.extra && byKey.extra.last_value;
  if (extra) { try { Object.assign(reading, JSON.parse(extra)); } catch (e) { /* laat staan */ } }

  let boat = null;
  const nmea = byKey.nmea && byKey.nmea.last_value;
  if (nmea) { try { boat = JSON.parse(nmea); } catch (e) { boat = null; } }

  // De publieke feedlijst zet de tijd van de laatste meting in last_value_at en
  // stuurt geen updated_at mee; de geauthenticeerde variant doet het andersom.
  // Beide lezen, anders blijft de leeftijd Infinity en meldt het dashboard
  // eeuwig "verbinden" terwijl de gegevens gewoon binnenkomen.
  const stamps = [];
  (feeds || []).forEach((f) => {
    ['last_value_at', 'updated_at'].forEach((veld) => {
      const ms = f && f[veld] && new Date(f[veld]).getTime();
      if (typeof ms === 'number' && !Number.isNaN(ms)) stamps.push(ms);
    });
  });
  const updated = stamps.length ? Math.max(...stamps) : null;

  return { reading, boat, updated };
}

export function aioChartSeries(pvItems, altItems, bucket = 300) {
  const rijen = new Map();
  const voegToe = (items, veld) => (items || []).forEach((it) => {
    const ms = new Date(it.created_at).getTime();
    const v = Number(it.value);
    if (Number.isNaN(ms) || !Number.isFinite(v)) return;
    const t = Math.floor(ms / 1000 / bucket) * bucket;   // zelfde tijdvakken als lokaal
    if (!rijen.has(t)) rijen.set(t, { t });
    rijen.get(t)[veld] = v;
  });
  voegToe(pvItems, 'pv_power');
  voegToe(altItems, 'alt_power');
  return [...rijen.values()].sort((a, b) => a.t - b.t);
}

// ---------- browser-only wiring (guarded so node import is side-effect free) ----------
function markStale(stale) {
  const banner = document.getElementById('staleBanner');
  if (banner) banner.style.display = stale ? 'flex' : 'none';
}

// --- alarm runtime (uses the tested alarmReason/evaluateAlarms) ---

/**
 * Gesproken alarm in plaats van een piep.
 *
 * De zinnen zijn vooraf ingesproken en staan als bestand op de Pi, zodat dit
 * midden op zee zonder internet werkt. welke bestanden bij welke situatie horen
 * bepaalt stem.js — puur en getest, want een melding die de verkeerde peiling
 * noemt is erger dan geen melding.
 *
 * Lukt afspelen niet — geen geluidskaart, bestand weg, browser die dwarsligt —
 * dan klinkt alsnog de oude piep. Bij alarm is stilte de enige uitkomst die
 * echt fout is.
 */
const MELDING_PAUZE_MS = 20000;

function speelBestand(url) {
  return new Promise((klaar, mis) => {
    const a = new Audio(url);
    a.onended = klaar;
    a.onerror = () => mis(new Error(`kan ${url} niet afspelen`));
    const p = a.play();
    if (p && p.catch) p.catch(mis);
  });
}

async function spreekAlarm(schip, eigen) {
  if (_spreekt) return;
  _spreekt = true;
  try {
    const bestanden = meldingBestanden(schip, eigen);
    for (const naam of bestanden) await speelBestand(`geluid/${naam}`);
  } catch (e) {
    alarmBeep();
  } finally {
    _spreekt = false;
  }
}

function alarmBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();   // unattended kiosk
    const t = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator(), g = _audioCtx.createGain();
    osc.type = 'square'; osc.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(g); g.connect(_audioCtx.destination);
    osc.start(t); osc.stop(t + 0.3);
  } catch (e) { /* audio unavailable */ }
}

// Filter + slice the AIS list per settings, evaluate alarms, render + sound.
function processAis() {
  const s = _settings;
  let list = _lastAis || [];
  if (s) {
    if (s.ais_min_sog_kn > 0) {
      list = list.filter(t => t.sog_kn == null || t.sog_kn >= s.ais_min_sog_kn);
    }
    list = list.slice(0, s.ais_max_ships);
  } else {
    list = list.slice(0, 10);
  }
  let threatSet = new Set();
  if (s) {
    const res = evaluateAlarms(list, s,
      { ackMmsi: _ackMmsi, snoozeUntil: _snoozeUntil, now: Date.now() });
    threatSet = new Set(res.threats.map(t => t.mmsi));
    // drop acks for ships that left the zone, so they re-arm if they return
    for (const m of [..._ackMmsi]) if (!threatSet.has(m)) _ackMmsi.delete(m);
    updateAlarmUi(res);
  }
  renderAis(list, document, threatSet);
  if (_aisMapOpen) renderAisMap();
}

function updateAlarmUi(res) {
  const banner = document.getElementById('alarmBanner');
  if (!banner) return;
  if (res.threats.length) {
    const near = res.threats.slice().sort((a, b) => a.dist_nm - b.dist_nm)[0];
    const tcpa = near.tcpa_min != null ? ` · ${Math.round(near.tcpa_min)} min` : '';
    const txt = document.getElementById('alarmText');
    if (txt) txt.textContent = `⚠ ${near.name} · ${Number(near.dist_nm).toFixed(2)} NM${tcpa}`
      + (res.snoozed ? '  (gesnoozed)' : '');
    banner.style.display = 'flex';
    banner.classList.toggle('sounding', res.sound);
    // Een gesproken melding duurt zes tot acht seconden; de oude tel van twee
    // seconden zou hem over zichzelf heen laten struikelen.
    if (res.sound && !_spreekt && Date.now() - _lastBeep > MELDING_PAUZE_MS) {
      _lastBeep = Date.now();
      spreekAlarm(near, _self);
    }
  } else {
    banner.style.display = 'none';
    banner.classList.remove('sounding');
  }
}

// Called by the Instellingen sliders: apply live, persist (debounced), side-effects.
export function setSetting(key, value) {
  if (!_settings) _settings = {};
  _settings[key] = value;
  if (typeof window !== 'undefined') window.__settings = _settings;
  processAis();
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }) })
      .then(r => r.json()).then(s => { _settings = s; if (typeof window !== 'undefined') window.__settings = s; })
      .catch(() => {});
  }, 400);
  if (key === 'screen_brightness') fetch('/api/screen/brightness/' + value, { method: 'POST' }).catch(() => {});
}
export function ackThreat(mmsi) { if (mmsi) { _ackMmsi.add(mmsi); processAis(); } }
export function snoozeAlarms() {
  const m = (_settings && _settings.alarm_snooze_min) || 10;
  _snoozeUntil = Date.now() + m * 60000;
  processAis();
}
function loadSettings() {
  fetch('/api/settings').then(r => r.json()).then(s => {
    _settings = s;
    if (typeof window !== 'undefined') window.__settings = s;
    processAis();
  }).catch(() => {});
}
if (typeof window !== 'undefined') {
  window.setSetting = setSetting; window.ackThreat = ackThreat; window.snoozeAlarms = snoozeAlarms;
}

// Local mode: live WebSocket + /api/history.
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  let lastMsg = Date.now();
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.reading) applyReading(data.reading);
    if (data.boat) applyBoat(data.boat);
    if (data.ais) { _lastAis = data.ais; processAis(); }
    if (data.total_solar_w != null || data.victron) applyVictron(data.victron, data.total_solar_w);
    lastMsg = Date.now();
    markStale(false);                  // data is flowing
  };
  ws.onclose = () => { markStale(true); setTimeout(connect, 2000); };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  // banner only on a real loss of the live connection, not charger hiccups
  setInterval(() => { markStale(Date.now() - lastMsg > 6000); }, 2000);
}

async function refreshChart() {
  const until = Math.floor(Date.now() / 1000);
  const since = until - 24 * 3600;
  try {
    const res = await fetch(`/api/history?metrics=pv_power,alt_power&since=${since}&until=${until}&bucket=300`);
    const { series } = await res.json();
    renderChart(series);
  } catch (e) { /* keep last chart on error */ }
}

// Cloud-modus: de Pi publiceert data/nu.json naast de site. Dit verving de
// Adafruit-feeds, die een plafond van tien feeds en 1024 bytes per waarde hadden.
// Lui bepalen: dit bestand moet importeerbaar blijven in node, waar `location`
// niet bestaat. De hele module is daarom vrij van neveneffecten bij het laden.
function dataBasis() {
  const map = CFG.data || 'data';
  const pad = (typeof location !== 'undefined' && location.pathname) || '';
  return pad.includes('/cockpit') ? `../${map}` : map;
}

async function cloudTick() {
  try {
    const res = await fetch(`${dataBasis()}/nu.json?t=${Date.now()}`);
    if (!res.ok) { markStale(true); return; }
    const nu = await res.json();
    if (nu.reading) applyReading(nu.reading);
    if (nu.boat) applyBoat(nu.boat);
    if (nu.ais) applyAisFromCloud(nu.ais);
    if (nu.victron || nu.total_solar_w != null) {
      applyVictron(nu.victron, nu.total_solar_w);
    }
    const ageS = nu.t ? (Date.now() / 1000 - nu.t) : Infinity;
    markStale(ageS > 300);
  } catch (e) { markStale(true); }
}

function applyAisFromCloud(lijst) {
  // De gepubliceerde lijst gebruikt korte sleutels om bytes te sparen.
  const ships = (lijst || []).map((s) => ({
    name: s.n ?? s.name, mmsi: s.mmsi, dist_nm: s.d ?? s.dist_nm,
    sog_kn: s.s ?? s.sog_kn, cog_deg: s.c ?? s.cog_deg,
    lat: s.a ?? s.lat, lon: s.o ?? s.lon,
  }));
  _lastAis = ships;
  renderAis(ships);
}

async function cloudChart() {
  try {
    const dag = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${dataBasis()}/dag-${dag}.jsonl?t=${Date.now()}`);
    if (!res.ok) return;
    const reeks = (await res.text()).split('\n').filter(Boolean).map((r) => {
      try {
        const x = JSON.parse(r);
        return { t: x.ts, pv_power: x.pv_power, alt_power: x.alt_power };
      } catch (e) { return null; }
    }).filter(Boolean);
    renderChart(reeks);
  } catch (e) { /* laatste grafiek laten staan */ }
}

function startCloud() {
  cloudTick();
  cloudChart();
  setInterval(cloudTick, 30000);
  setInterval(cloudChart, 120000);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    if (CFG.mode === 'cloud') {
      startCloud();
    } else {
      connect();
      refreshChart();
      setInterval(refreshChart, 60000);
      refreshWind();
      setInterval(refreshWind, 10000);
    }
    // AIS radar map (own ships-around-me view)
    const vb = document.getElementById('verkeerBtn');
    const aisOv = document.getElementById('aisMapOverlay');
    if (vb && aisOv) {
      vb.addEventListener('click', () => { _aisMapOpen = true; renderAisMap(); aisOv.style.display = 'flex'; });
      const ac = document.getElementById('aisMapClose');
      if (ac) ac.addEventListener('click', () => { _aisMapOpen = false; aisOv.style.display = 'none'; });
    }
    // settings (alarm/AIS/screen) + per-ship alarm acknowledge
    loadSettings();
    const aisTable = document.getElementById('aisTable');
    if (aisTable) aisTable.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.ais-row.ais-threat');
      if (row && row.dataset.mmsi) ackThreat(row.dataset.mmsi);
    });
  });
}
