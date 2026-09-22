// Live meekijken op de camera's van de boot, voor vrienden.
//
// De Pi zet twee stille (geluidloze) stromen open via Tailscale Funnel, achter
// een poortwachter (renogy_dashboard/kijk.py) die alleen die twee bronnen, de
// bediening van de 360-camera en een statusregel doorlaat. Pim zet dat aan en
// uit op het kuipscherm. Deze module tekent het vak: staat het aan, dan kun je
// per camera op "Kijk live" tikken; de stroom stopt na een kwartier, want elke
// kijker kost de boot satellietdata.
//
// De speler is die van go2rtc zelf (video-rtc.js). We vragen hem uitsluitend om
// video: geen geluid, ook niet als de bron het zou hebben.

// De speler pas laden als hij nodig is: video-rtc.js verwacht een browser
// (HTMLElement) en deze module wordt ook door node getoetst.
let spelerKlaar = null;
function laadSpeler() {
  if (!spelerKlaar) {
    spelerKlaar = import('./video-rtc.js?v=a3fe9b5e').then(({ VideoRTC }) => {
      if (!customElements.get('video-rtc')) customElements.define('video-rtc', VideoRTC);
    });
  }
  return spelerKlaar;
}

export const KIJK_DUUR_MS = 15 * 60 * 1000;
const NAMEN = { boatcam_stil: 'Kuipcamera · 360°', ring_stil: 'Ring' };

/** Wat het statusbestand betekent, in woorden. Puur, voor node. */
export function kijkStatusTekst(s) {
  if (!s) return { aan: false, offline: true, tekst: 'de boot is nu offline', klasse: 'weg' };
  if (!s.aan) return { aan: false, tekst: 'de camera\'s staan uit', klasse: 'uit' };
  const n = s.kijkers || 0;
  const vol = n >= (s.max_kijkers || 4);
  return {
    aan: true, vol,
    tekst: n === 0 ? 'aan · niemand kijkt' : `aan · ${n} kijker${n === 1 ? '' : 's'}${vol ? ' (vol)' : ''}`,
    klasse: vol ? 'vol' : 'aan',
  };
}

/** De WebSocket-URL van een stroom; go2rtc's speler maakt er zelf wss:// van. */
export function stroomUrl(basis, bron) {
  return `${basis.replace(/\/$/, '')}/api/ws?src=${encodeURIComponent(bron)}`;
}

export function ptzUrl(basis, move) {
  return `${basis.replace(/\/$/, '')}/ptz/${move}`;
}

export async function haalKijkStatus(basis, fetchFn = fetch) {
  try {
    const r = await fetchFn(`${basis.replace(/\/$/, '')}/status.json`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

/** Een speler maken: alleen video, en nooit WebRTC (komt niet door de Funnel). */
export function maakSpeler(basis, bron, doc = document) {
  const v = doc.createElement('video-rtc');
  v.mode = 'mse,hls,mjpeg';
  v.media = 'video';
  v.background = false;
  v.dataset.bron = bron;
  // `src` verbindt meteen, dus pas zetten als hij in de pagina hangt.
  v.dataset.src = stroomUrl(basis, bron);
  return v;
}

/**
 * Het vak bedraden. `basis` is de Funnel-URL uit config.js. Zonder die URL
 * bestaat het vak niet.
 */
export function bedraadKijk(basis, doc = document, fetchFn = fetch) {
  const vak = doc.getElementById('kijkvak');
  if (!vak || !basis) return null;
  const status = doc.getElementById('kijkStatus');
  const lopend = {};          // bron -> { speler, timer }

  const stop = (bron) => {
    const l = lopend[bron];
    if (!l) return;
    clearTimeout(l.timer);
    l.speler.remove();
    delete lopend[bron];
    const beeld = doc.getElementById(`kijk_${bron}`);
    if (beeld) beeld.querySelector('.kijkstart').hidden = false;
    const pad = doc.getElementById(`ptz_${bron}`);
    if (pad) pad.hidden = true;
  };

  const start = async (bron) => {
    if (lopend[bron]) return;
    const beeld = doc.getElementById(`kijk_${bron}`);
    if (!beeld) return;
    await laadSpeler();
    if (lopend[bron]) return;
    const speler = maakSpeler(basis, bron, doc);
    beeld.appendChild(speler);
    speler.src = speler.dataset.src;
    beeld.querySelector('.kijkstart').hidden = true;
    const pad = doc.getElementById(`ptz_${bron}`);
    if (pad) pad.hidden = false;
    // Na een kwartier stoppen we zelf; de Pi doet dat ook. Verder kijken is
    // één tik -- en een bewuste keuze, want het kost de boot data.
    lopend[bron] = { speler, timer: setTimeout(() => stop(bron), KIJK_DUUR_MS) };
  };

  vak.querySelectorAll('.kijkstart').forEach((b) => {
    b.addEventListener('click', () => start(b.dataset.bron));
  });

  // De bediening van de 360-camera: ingedrukt = bewegen, loslaten = stop.
  const ptz = (move) => fetchFn(ptzUrl(basis, move), { method: 'POST' }).catch(() => {});
  vak.querySelectorAll('.ptzknop').forEach((b) => {
    const move = b.dataset.move;
    const los = (e) => { e.preventDefault(); ptz('stop'); };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); ptz(move); });
    b.addEventListener('pointerup', los);
    b.addEventListener('pointerleave', los);
    b.addEventListener('pointercancel', los);
  });

  vak.hidden = false;   // altijd zichtbaar; de status zegt of het nu kan
  const ververs = async () => {
    const s = await haalKijkStatus(basis, fetchFn);
    const t = kijkStatusTekst(s);
    if (status) { status.textContent = t.tekst; status.className = `kijkstatus ${t.klasse}`; }
    vak.classList.toggle('dicht', !t.aan);
    if (!t.aan) Object.keys(lopend).forEach(stop);
    vak.querySelectorAll('.kijkstart').forEach((b) => { b.disabled = !t.aan || t.vol; });
  };
  ververs();
  const timer = setInterval(ververs, 30000);
  return { start, stop, ververs, timer };
}
