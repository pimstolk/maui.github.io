// Maui — volgdashboard voor thuis.
//
// Alles op deze pagina komt uit de publieke Adafruit-feeds. De historie zit in
// historie.js (puur, getest); dit bestand tekent er de kaart, de tijdschuif, de
// aflezingen en de grafieken bij.

import { VRAAG, klopt, onthoud, magBinnen } from './poort.js?v=af1c33a3';
import { windroosSvg, kompasSvg, windZijde } from './instrumenten.js?v=af7fe36b';
import {
  haalHistorie, haalNu, haalRoutes, haalSpoor, haalFotos, trackVan, trackStukken,
  monsterOp, reeksVan, reeksStukken, leeftijdTekst, plaatsVanFoto, spreid,
} from './historie.js?v=446923d6';

const $ = (id) => document.getElementById(id);
const KLEUR = { wind: '#67d6c4', richting: '#d9c9a3', sog: '#ffb547', stw: '#58a8ff',
                renogy: '#ffc24b', victron: '#35c9c9',
                // Geplande routes: koel blauw, streepjes. Nooit het zandgeel van
                // de gevaren track en nooit het magenta van "nu" — een plan mag
                // er niet uitzien als iets dat al gebeurd is.
                plan: '#6fb2ff' };

let monsters = [];          // de nmea-historie, chronologisch
let accuReeks = [];         // [{t, v}] accupercentage
let renogyReeks = [];       // [{t, v}] zonvermogen Renogy
let victronReeks = [];      // [{t, v}] zonvermogen Victron
let gekozenT = null;        // null = "nu" (het nieuwste monster)
let routes = [];            // geüploade GPX-routes; los van de tijdschuif
let spoor = [];             // de héle gevaren route sinds het begin, ook los ervan
let fotos = [];             // het camera-archief, oudste eerst
let kaart, laagRoutes, laagTrack, laagFotos, laagFix;

// ---------- ophalen ---------------------------------------------------------

let nu = null;              // data/nu.json: laatste stand, schepen, camerabeeld

async function laad(uren) {
  const [ms, n, r, s, f] = await Promise.all([
    haalHistorie(uren), haalNu(), haalRoutes(), haalSpoor(), haalFotos()]);
  monsters = ms;
  nu = n;
  routes = r;
  spoor = s;
  fotos = f;
  // De zonnereeksen zitten in dezelfde regels; apart ophalen hoeft niet meer.
  renogyReeks = reeksVan(monsters, 'renogy');
  victronReeks = reeksVan(monsters, 'victron');
  accuReeks = reeksVan(monsters, 'soc');
  gekozenT = null;
  tekenAlles();
}

// ---------- kaart -----------------------------------------------------------

function maakKaart() {
  // Leaflet komt van een CDN. Is dat traag of onbereikbaar, dan hoort de rest
  // van het dashboard gewoon te werken: liever cijfers zonder kaart dan een
  // lege pagina. Alles wat de kaart aanraakt controleert daarom op `kaart`.
  if (typeof L === 'undefined') {
    const leeg = $('kaartLeeg');
    if (leeg) {
      leeg.hidden = false;
      leeg.textContent = 'De kaart kon niet geladen worden. De gegevens hieronder kloppen wel.';
    }
    return;
  }
  kaart = L.map('kaart', { zoomControl: true, attributionControl: true });
  // Donkere tegels mét plaatsnamen: zonder namen is het een grijze vlek en kan
  // niemand thuis zien dat dit Normandië is.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  }).addTo(kaart);
  // Volgorde is betekenis: de geüploade routes liggen onderop, daarboven de
  // werkelijk gevaren track, en bovenop waar we nu zijn.
  laagRoutes = L.layerGroup().addTo(kaart);
  laagTrack = L.layerGroup().addTo(kaart);
  laagFotos = L.layerGroup().addTo(kaart);
  laagFix = L.layerGroup().addTo(kaart);
  kaart.setView([49.64, -1.62], 9);        // Het Kanaal, tot er iets beters is
}

/**
 * De geüploade GPX-routes. Ze staan los van de tijdschuif — een route is een
 * plan, geen meting — dus ze blijven staan terwijl je door de tijd bladert.
 */
function tekenRoutes() {
  if (!kaart) return [];
  laagRoutes.clearLayers();
  const alle = [];

  routes.forEach((r) => {
    const punten = r.punten.map((p) => [p[0], p[1]]);
    alle.push(...punten);
    const naam = r.naam || 'Route';

    if (r.soort === 'punten') {
      punten.forEach((p, i) => {
        const merk = L.circleMarker(p, { radius: 4, color: KLEUR.plan, weight: 1.5,
                                         fillOpacity: .35, interactive: true });
        merk.bindTooltip((r.namen && r.namen[i]) || naam);
        merk.addTo(laagRoutes);
      });
      return;
    }
    if (punten.length < 2) return;

    // Een spoor is gevaren, een route is bedacht. Doorgetrokken tegenover
    // streepjes, zodat je op de kaart ziet welke van de twee je voor je hebt.
    const gevaren = r.soort === 'spoor';
    L.polyline(punten, {
      color: KLEUR.plan, weight: 2, opacity: gevaren ? .5 : .75,
      dashArray: gevaren ? null : '6 6',
    }).bindTooltip(naam, { sticky: true }).addTo(laagRoutes);
  });

  return alle;
}

function fixIcoon() {
  // Het fix-symbool van een navigator: cirkel met een punt erin.
  return L.divIcon({
    className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: '<div class="fix" style="width:22px;height:22px">'
        + '<span class="puls"></span><span class="ring"></span><span class="punt"></span></div>',
  });
}

/**
 * De foto's op de kaart, op de plek waar ze gemaakt zijn.
 *
 * Het tijdstip zit in de bestandsnaam, de plaats halen we uit het spoor. Weten
 * we de plaats niet zeker, dan komt de foto er niet op — een beeld op een
 * verzonnen positie is erger dan een beeld dat alleen in de galerij staat.
 *
 * Honderden merktekens worden een grijze massa, dus we spreiden ze over de
 * reis. Alles blijft wel in de galerij staan.
 */
/**
 * De galerij: alles wat de camera ooit maakte, per dag.
 *
 * Nieuwste dag bovenaan, want daar begint iedereen. Beelden lazy geladen —
 * honderden JPEGs tegelijk ophalen zou de pagina op een telefoon onderuit
 * halen, en je ziet er toch maar een paar tegelijk.
 */
function tekenGalerij() {
  const vak = $('galerij'), dagen = $('galerijDagen'), tel = $('galerijTel');
  if (!vak || !dagen) return;
  vak.hidden = fotos.length === 0;
  if (!fotos.length) return;

  tel.textContent = `${fotos.length} beeld${fotos.length === 1 ? '' : 'en'}`;
  const perDag = new Map();
  fotos.forEach((f) => {
    if (!perDag.has(f.dag)) perDag.set(f.dag, []);
    perDag.get(f.dag).push(f);
  });

  dagen.innerHTML = '';
  [...perDag.keys()].sort().reverse().forEach((dag) => {
    const blok = document.createElement('div');
    blok.className = 'galerij-dag';

    const kop = document.createElement('div');
    kop.className = 'galerij-datum';
    kop.textContent = new Date(dag + 'T12:00:00').toLocaleDateString('nl-NL',
      { weekday: 'long', day: 'numeric', month: 'long' });
    blok.appendChild(kop);

    const strook = document.createElement('div');
    strook.className = 'galerij-strook';
    perDag.get(dag).slice().reverse().forEach((f) => {
      const knop = document.createElement('button');
      knop.className = 'duim';
      knop.type = 'button';
      const img = document.createElement('img');
      img.src = f.pad;
      img.loading = 'lazy';
      img.alt = '';
      const bij = document.createElement('span');
      bij.textContent = klok(f.t);
      knop.append(img, bij);
      knop.addEventListener('click', () => toonBeeld(f));
      strook.appendChild(knop);
    });
    blok.appendChild(strook);
    dagen.appendChild(blok);
  });
}

function toonBeeld(f) {
  const venster = $('beeldvenster');
  if (!venster) return;
  $('beeldGroot').src = f.pad;
  $('beeldBij').textContent = `${datumKlok(f.t)}`;
  venster.hidden = false;
}

function tekenFotos() {
  if (!kaart) return;
  laagFotos.clearLayers();
  if (!fotos.length) return;

  // De positie die de Pi bij de foto vastlegde is de waarheid. Alleen voor
  // oudere foto's, die die nog niet hebben, zoeken we hem in het spoor.
  const metPlek = fotos
    .map((f) => ({
      ...f,
      plek: Number.isFinite(f.lat) && Number.isFinite(f.lon)
        ? { lat: f.lat, lon: f.lon }
        : plaatsVanFoto(spoor, f.t),
    }))
    .filter((f) => f.plek);

  spreid(metPlek, 40).forEach((f) => {
    const merk = L.marker([f.plek.lat, f.plek.lon], {
      icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
                        html: '<span class="fotostip"></span>' }),
      keyboard: false,
    });
    merk.bindPopup(
      `<div class="fotopop"><img src="${f.pad}" alt="" loading="lazy">`
      + `<span>${klok(f.t)} · ${f.dag}</span></div>`,
      { maxWidth: 260, className: 'fotopopup' });
    merk.addTo(laagFotos);
  });
}

function tekenKaart() {
  if (!kaart) return;
  laagTrack.clearLayers();
  laagFix.clearLayers();
  const routePunten = tekenRoutes();
  tekenFotos();

  // De hele reis, niet alleen het gekozen venster. Anders verdween de vorige
  // zeebeen zodra er een nieuwe bij kwam, terwijl de kaart juist het geheugen
  // van de reis hoort te zijn. Het venster en de tijdschuif gaan alleen nog
  // over de aflezingen en de grafieken.
  // Valt het spoorbestand weg, dan tekenen we wat het venster kent — liever een
  // stuk track dan geen.
  const track = spoor.length ? spoor : trackVan(monsters);
  $('kaartLeeg').hidden = track.length > 0 || routePunten.length > 0;
  if (!track.length) {
    // Nog nooit gevaren, maar wel al een route geüpload: laat die dan zien in
    // plaats van een lege zee.
    if (routePunten.length && !tekenKaart.gepast) {
      kaart.fitBounds(L.latLngBounds(routePunten).pad(0.2), { maxZoom: 13 });
      tekenKaart.gepast = true;
    }
    return;
  }

  // Elk aaneengesloten stuk apart, zodat er geen rechte streep over land loopt
  // waar we simpelweg niets weten.
  const stukken = trackStukken(track);
  stukken.forEach((stuk) => {
    if (stuk.length < 2) return;
    L.polyline(stuk.map((p) => [p.lat, p.lon]),
      { color: KLEUR.richting, weight: 2.5, opacity: .85 }).addTo(laagTrack);
  });

  const m = huidigMonster();
  const fix = (m && m.lat !== null) ? m : track[track.length - 1];
  L.marker([fix.lat, fix.lon], { icon: fixIcoon(), keyboard: false }).addTo(laagFix);

  // Schepen om ons heen — alleen bij "nu"; op een oud tijdstip weten we niet
  // meer wie er lag, en een oude lijst op een nieuwe kaart is een leugen.
  if (gekozenT === null && nu && Array.isArray(nu.ais)) {
    nu.ais.forEach((sch) => {
      const la = sch.a !== undefined ? sch.a : sch.lat;
      const lo = sch.o !== undefined ? sch.o : sch.lon;
      if (la == null || lo == null) return;
      L.circleMarker([la, lo], {
        radius: 3.5, color: '#7b93aa', weight: 1, fillOpacity: .5, interactive: true,
      }).bindTooltip(`${sch.n || sch.name || '?'} · ${(sch.d ?? sch.dist_nm ?? 0).toFixed(2)} NM`)
        .addTo(laagFix);
    });
  }

  if (!tekenKaart.gepast) {
    // Alleen op de gevaren track passen: waar we zijn is het onderwerp. Een
    // route naar Noorwegen mag de boot niet tot een speldenprik terugbrengen.
    const alle = track.map((p) => [p.lat, p.lon]);
    kaart.fitBounds(L.latLngBounds(alle).pad(0.35), { maxZoom: 13 });
    tekenKaart.gepast = true;
  }
}

// ---------- aflezingen ------------------------------------------------------

function huidigMonster() {
  if (!monsters.length) return null;
  return gekozenT === null ? monsters[monsters.length - 1] : monsterOp(monsters, gekozenT);
}

const getal = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const graden = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}°`);

function graadMinuut(waarde, positief, negatief) {
  if (waarde === null || waarde === undefined) return '—';
  const teken = waarde >= 0 ? positief : negatief;
  const abs = Math.abs(waarde);
  const g = Math.floor(abs);
  const m = (abs - g) * 60;
  return `${g}° ${m.toFixed(3)}′ ${teken}`;
}

function tekenAflezingen() {
  const m = huidigMonster();
  const zet = (id, tekst) => { const e = $(id); if (e) e.innerHTML = tekst; };

  if (!m) {
    ['afPositie', 'afSog', 'afStw', 'afWind', 'afDiepte', 'afAccu']
      .forEach((id) => zet(id, '—'));
    return;
  }
  zet('afPositie', m.lat === null ? '—'
    : `${graadMinuut(m.lat, 'N', 'Z')}<br>${graadMinuut(m.lon, 'O', 'W')}`);
  zet('afPositieBij', m.lat === null ? 'geen fix op dit moment' : 'fix');

  zet('afSog', `${getal(m.sog)}<small>kn</small>`);
  zet('afCog', `koers ${graden(m.cog)}`);
  zet('afStw', `${getal(m.stw)}<small>kn</small>`);
  zet('afHdg', `kompas ${graden(m.hdg)}`);
  zet('afWind', `${getal(m.aws)}<small>kn</small>`);
  zet('afWindHoek', m.awa === null ? '—'
    : `${Math.abs(Math.round(m.awa))}° ${m.awa >= 0 ? 'stuurboord' : 'bakboord'}`);
  zet('afDiepte', `${getal(m.depth)}<small>m</small>`);
  zet('afTrip', m.trip === null ? '—' : `reis ${getal(m.trip)} nm`);

  // Zon uitgesplitst: het totaal beantwoordt de vraag niet welk paneel wat doet.
  const opMoment = (reeks) => (reeks.length ? monsterOp(reeks, m.t) : null);
  const ren = opMoment(renogyReeks), vic = opMoment(victronReeks);
  const totaal = (ren ? ren.v : 0) + (vic ? vic.v : 0);
  zet('afZon', (ren || vic) ? `${Math.round(totaal)}<small>W</small>` : '—');
  zet('afZonBij', (ren || vic)
    ? `Renogy ${ren ? Math.round(ren.v) : '—'} W · Victron ${vic ? Math.round(vic.v) : '—'} W`
    : 'geen meting');

  const accu = accuReeks.length
    ? monsterOp(accuReeks.map((p) => ({ t: p.t, v: p.v })), m.t) : null;
  zet('afAccu', accu ? `${Math.round(accu.v)}<small>%</small>` : '—');
  zet('afAccuBij', accu ? 'accupercentage' : 'geen meting');
}

// ---------- grafieken -------------------------------------------------------

const B = 600, H = 156, PAD = { l: 6, r: 6, t: 10, b: 16 };

function pad(punten, t0, t1, min, max) {
  if (punten.length < 2) return '';
  const bx = (t) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (B - PAD.l - PAD.r);
  const by = (v) => H - PAD.b - ((v - min) / Math.max(1e-9, max - min)) * (H - PAD.t - PAD.b);
  // Per aaneengesloten stuk een eigen M...L-reeks: een gat blijft een gat.
  return reeksStukken(punten).map((stuk) => stuk
    .map((p, i) => `${i ? 'L' : 'M'}${bx(p.t).toFixed(1)},${by(p.v).toFixed(1)}`)
    .join('')).join(' ');
}

function tekenGrafiek(svgId, leegId, reeksen) {
  const svg = $(svgId), leeg = $(leegId);
  const bruikbaar = reeksen.filter((r) => r.punten.length >= 2);
  if (!bruikbaar.length) { svg.innerHTML = ''; leeg.hidden = false; return; }
  leeg.hidden = true;

  const t0 = Math.min(...bruikbaar.map((r) => r.punten[0].t));
  const t1 = Math.max(...bruikbaar.map((r) => r.punten[r.punten.length - 1].t));

  let uit = '';
  bruikbaar.forEach((r, i) => {
    const waarden = r.punten.map((p) => p.v);
    const min = r.min !== undefined ? r.min : Math.min(...waarden);
    const max = r.max !== undefined ? r.max : Math.max(...waarden, min + 1);
    // Alleen de hoofdreeks krijgt een schaal; twee stel cijfers is ruis.
    if (i === 0) {
      const label = (v, y) => `<text x="${PAD.l}" y="${y}" fill="${r.kleur}" opacity=".75" `
        + `font-family="var(--data)" font-size="10">${Math.round(v)}${r.eenheid || ''}</text>`;
      uit += label(max, PAD.t + 2) + label(min, H - PAD.b - 2);
    }
    uit += `<path d="${pad(r.punten, t0, t1, min, max)}" fill="none" `
         + `stroke="${r.kleur}" stroke-width="${r.dun ? 1.2 : 1.8}" `
         + `stroke-linejoin="round" stroke-linecap="round"`
         + `${r.dun ? ' opacity=".65"' : ''} />`;
  });

  // Het gekozen moment als magenta streep — dezelfde kleur als de fix.
  const m = huidigMonster();
  if (m && t1 > t0) {
    const x = PAD.l + ((m.t - t0) / (t1 - t0)) * (B - PAD.l - PAD.r);
    uit += `<line x1="${x.toFixed(1)}" y1="${PAD.t - 6}" x2="${x.toFixed(1)}" y2="${H - PAD.b}" `
         + `stroke="#e5348b" stroke-width="1.2" opacity=".9" />`;
  }
  svg.innerHTML = uit;
}

function tekenGrafieken() {
  tekenGrafiek('grWind', 'grWindLeeg', [
    { punten: reeksVan(monsters, 'aws'), kleur: KLEUR.wind, min: 0, eenheid: ' kn' },
    { punten: reeksVan(monsters, 'awa'), kleur: KLEUR.richting, min: -180, max: 180, dun: true },
  ]);
  tekenGrafiek('grSnelheid', 'grSnelheidLeeg', [
    { punten: reeksVan(monsters, 'sog'), kleur: KLEUR.sog, min: 0, eenheid: ' kn' },
    { punten: reeksVan(monsters, 'stw'), kleur: KLEUR.stw, min: 0 },
  ]);
  // Beide bronnen op dezelfde schaal, anders zijn ze niet te vergelijken.
  const zonMax = Math.max(
    10,
    ...renogyReeks.map((p) => p.v),
    ...victronReeks.map((p) => p.v));
  tekenGrafiek('grZon', 'grZonLeeg', [
    { punten: renogyReeks, kleur: KLEUR.renogy, min: 0, max: zonMax, eenheid: ' W' },
    { punten: victronReeks, kleur: KLEUR.victron, min: 0, max: zonMax },
  ]);
}

// ---------- kop en tijdschuif ----------------------------------------------

const klok = (t) => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const datumKlok = (t) => new Date(t).toLocaleString('nl-NL',
  { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function tekenKop() {
  const vers = $('vers'), tekst = $('versTekst');
  if (!monsters.length) {
    vers.className = 'vers stil';
    tekst.textContent = 'nog geen gegevens ontvangen';
    return;
  }
  const laatst = nu && nu.t ? nu.t * 1000 : monsters[monsters.length - 1].t;
  const oud = Date.now() - laatst;
  vers.className = 'vers' + (oud > 6 * 3600e3 ? ' stil' : oud > 20 * 60e3 ? ' oud' : '');
  tekst.innerHTML = `laatste bericht <b>${leeftijdTekst(oud)}</b> · ${datumKlok(laatst)}`;
}

function tekenSchuif() {
  const s = $('schuif');
  s.disabled = monsters.length < 2;
  if (!monsters.length) { $('vanaf').textContent = '—'; $('moment').textContent = '—'; return; }
  const t0 = monsters[0].t, t1 = monsters[monsters.length - 1].t;
  $('vanaf').textContent = datumKlok(t0);
  $('totEn').textContent = gekozenT === null ? 'nu' : datumKlok(t1);
  const m = huidigMonster();
  $('moment').textContent = gekozenT === null
    ? `nu · ${klok(m.t)}` : datumKlok(m.t);
  if (gekozenT === null) s.value = 100;
}

function tekenSnapshot() {
  const vak = $('camera');
  if (!vak) return;
  const snap = nu && nu.snapshot;
  vak.hidden = !snap;
  if (!snap) return;
  const img = $('cameraBeeld');
  // Cachebreker op het moment van plaatsen, anders blijft een oud beeld hangen.
  img.src = `${snap.bestand}?t=${snap.geplaatst || 0}`;
  const gemaakt = snap.gemaakt ? new Date(snap.gemaakt * 1000) : null;
  $('cameraBij').textContent = gemaakt
    ? `opname van ${gemaakt.toLocaleString('nl-NL', { weekday: 'short', day: '2-digit',
        month: 'short', hour: '2-digit', minute: '2-digit' })}`
      + (snap.accu != null ? ` · camera-accu ${snap.accu}%` : '')
    : 'opnametijd onbekend';
}

function tekenInstrumenten() {
  const m = huidigMonster();
  const wr = $('windroos'), kp = $('kompas');
  if (!wr || !kp) return;
  wr.innerHTML = windroosSvg(m ? m.awa : null, m ? m.aws : null);
  kp.innerHTML = kompasSvg(m ? m.hdg : null, m ? m.cog : null);
  $('windroosBij').textContent = m && m.awa !== null
    ? `${Math.abs(Math.round(m.awa))}° ${windZijde(m.awa)}` : '—';
  // Kompaskoers naast grondkoers: die lopen uiteen zodra er stroom staat, en
  // juist dat verschil zegt iets.
  $('kompasBij').textContent = m && m.cog !== null
    ? `over de grond ${Math.round(m.cog)}°` : '—';
}

function tekenAlles() {
  tekenKop();
  tekenSnapshot();
  tekenInstrumenten();
  tekenSchuif();
  tekenKaart();
  tekenAflezingen();
  tekenGrafieken();
  tekenGalerij();
}

// ---------- opstarten -------------------------------------------------------

function bedraadBeeldvenster() {
  const venster = $('beeldvenster');
  if (!venster) return;
  const sluit = () => { venster.hidden = true; $('beeldGroot').src = ''; };
  $('beeldSluit')?.addEventListener('click', sluit);
  // Naast het beeld tikken sluit ook; op een telefoon is dat wat je vanzelf doet.
  venster.addEventListener('click', (e) => { if (e.target === venster) sluit(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sluit(); });
}

function bedraad() {
  bedraadBeeldvenster();
  $('schuif').addEventListener('input', (e) => {
    if (monsters.length < 2) return;
    const t0 = monsters[0].t, t1 = monsters[monsters.length - 1].t;
    const f = Number(e.target.value) / 100;
    gekozenT = f >= 0.999 ? null : t0 + f * (t1 - t0);
    tekenSchuif(); tekenKaart(); tekenAflezingen(); tekenInstrumenten(); tekenGrafieken();
  });

  document.querySelectorAll('.venster button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.venster button')
        .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      tekenKaart.gepast = false;                 // nieuw venster mag opnieuw inzoomen
      laad(Number(b.dataset.uren));
    });
  });
}

/** Laat de poort zien, of de pagina als er al eerder geantwoord is. */
function poortAf() {
  $('poort').hidden = true;
  $('blad').hidden = false;
  try { maakKaart(); } catch (e) { /* zonder kaart draait de rest door */ }
  // Leaflet meet zijn container bij het aanmaken. Die was tot een tel geleden
  // verborgen, dus de eerste meting kan nul zijn; dan blijft de kaart grijs of
  // half getekend. Even opnieuw laten meten zodra de opmaak rond is.
  requestAnimationFrame(() => setTimeout(() => kaart && kaart.invalidateSize(), 0));
  bedraad();
  laad(24);
  setInterval(() => { if (gekozenT === null) laad(activeUren()); }, 60000);
  setInterval(tekenKop, 20000);
}

function opstarten() {
  if (magBinnen(window.localStorage)) return poortAf();
  const poort = $('poort');
  poort.hidden = false;
  $('poortVraag').textContent = VRAAG;
  $('poortAntwoord').focus();
  $('poortForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const gegeven = $('poortAntwoord').value;
    if (!klopt(gegeven)) {
      $('poortFout').hidden = false;
      $('poortAntwoord').select();
      return;
    }
    onthoud(window.localStorage);
    poortAf();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    opstarten();
  });
}

function activeUren() {
  const b = document.querySelector('.venster button[aria-pressed=true]');
  return b ? Number(b.dataset.uren) : 24;
}
