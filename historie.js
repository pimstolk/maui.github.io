// De geschiedenis van de boot, op tijd geïndexeerd.
//
// De gegevens komen uit bestanden die de Pi zelf naar GitHub Pages duwt:
//
//   data/index.json          welke dagen er zijn
//   data/dag-JJJJ-MM-DD.jsonl  één meting per regel, uitgedund tot 2 minuten
//   data/nu.json             de laatste stand, inclusief AIS en camerabeeld
//
// Dit verving Adafruit IO. Daar gold een feedplafond van tien, 1024 bytes per
// waarde, dertig datapunten per minuut en dertig dagen bewaartermijn; hier is
// niets van dat alles een grens.
//
// Puur en zonder DOM, zodat node het kan testen.

/** Eén regel uit een dagbestand -> een vlak monster, of null als hij niet deugt. */
export function parseRij(rij) {
  if (!rij || rij.ts === undefined || rij.ts === null) return null;
  const t = Number(rij.ts) * 1000;
  if (!Number.isFinite(t)) return null;
  const num = (x) => {
    if (x === null || x === undefined || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  return {
    t,
    lat: num(rij.lat), lon: num(rij.lon),
    aws: num(rij.aws_kn), awa: num(rij.awa_deg),
    hdg: num(rij.heading_deg), cog: num(rij.cog_deg),
    stw: num(rij.stw_kn), sog: num(rij.sog_kn),
    depth: num(rij.depth_m),
    eng: num(rij.engineroom_c), exh: num(rij.exhaust_c),
    log: num(rij.log_nm), trip: num(rij.trip_nm),
    soc: num(rij.soc), renogy: num(rij.pv_power), victron: num(rij.victron_w),
  };
}

/** Een heel dagbestand (JSON Lines) -> monsters, chronologisch. */
export function parseJsonl(tekst) {
  return String(tekst || '')
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => { try { return parseRij(JSON.parse(r)); } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

/** Welke dagbestanden dekken de laatste *uren*? Nieuwste eerst is niet nodig. */
export function dagenVoorVenster(dagen, uren, nu = Date.now()) {
  const vanaf = new Date(nu - uren * 3600 * 1000).toISOString().slice(0, 10);
  return (dagen || []).filter((d) => d >= vanaf).sort();
}

/** Alleen de monsters met een echte positie, als [{t,lat,lon}] voor de kaart. */
export function trackVan(monsters) {
  return (monsters || [])
    .filter((m) => m.lat !== null && m.lon !== null)
    .map((m) => ({ t: m.t, lat: m.lat, lon: m.lon }));
}

/**
 * Knip een track in stukken waar een gat in de tijd zit.
 *
 * Zonder dit trekt de kaart een rechte streep dwars over land van waar de boot
 * verdween naar waar hij weer opdook — precies het soort verzonnen lijn dat we
 * nergens anders in dit project tolereren. Een gat betekent: we weten het niet.
 */
export function trackStukken(track, maxGatMs = 30 * 60 * 1000) {
  const stukken = [];
  let huidig = [];
  (track || []).forEach((p, i) => {
    if (i > 0 && p.t - track[i - 1].t > maxGatMs) {
      if (huidig.length) stukken.push(huidig);
      huidig = [];
    }
    huidig.push(p);
  });
  if (huidig.length) stukken.push(huidig);
  return stukken;
}

/** Het monster dat het dichtst bij tijdstip *t* ligt (binaire zoek). */
export function monsterOp(monsters, t) {
  if (!monsters || !monsters.length) return null;
  let lo = 0, hi = monsters.length - 1;
  if (t <= monsters[lo].t) return monsters[lo];
  if (t >= monsters[hi].t) return monsters[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (monsters[mid].t <= t) lo = mid; else hi = mid;
  }
  return (t - monsters[lo].t) <= (monsters[hi].t - t) ? monsters[lo] : monsters[hi];
}

/** Reeks voor een grafiek: [{t, waarde}] zonder de gaten. */
export function reeksVan(monsters, veld) {
  return (monsters || [])
    .filter((m) => m[veld] !== null && m[veld] !== undefined)
    .map((m) => ({ t: m.t, v: m[veld] }));
}

/**
 * Knip een grafiekreeks op waar een gat in de tijd zit.
 *
 * Dezelfde regel als voor de track: een lijn door een gat suggereert metingen
 * die er niet waren. De nacht dat de Pi uit stond werd anders een vloeiende
 * diagonaal dwars door de windgrafiek.
 */
export function reeksStukken(reeks, maxGatMs = 30 * 60 * 1000) {
  const stukken = [];
  let huidig = [];
  (reeks || []).forEach((p, i) => {
    if (i > 0 && p.t - reeks[i - 1].t > maxGatMs) {
      if (huidig.length) stukken.push(huidig);
      huidig = [];
    }
    huidig.push(p);
  });
  if (huidig.length) stukken.push(huidig);
  return stukken;
}

/**
 * Afgelegde afstand in zeemijlen over de track (haversine).
 *
 * Alleen binnen een aaneengesloten stuk: over een gat heen tellen zou een sprong
 * meerekenen die de boot nooit gevaren heeft.
 */
export function afstandNm(track, maxGatMs = 30 * 60 * 1000) {
  let som = 0;
  trackStukken(track, maxGatMs).forEach((stuk) => {
    for (let i = 1; i < stuk.length; i++) som += haversineNm(stuk[i - 1], stuk[i]);
  });
  return som;
}

export function haversineNm(a, b) {
  const R = 3440.065;                       // aardstraal in zeemijl
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Menselijke leeftijd: "net binnen", "12 min geleden", "3 uur geleden". */
export function leeftijdTekst(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'onbekend';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return 'net binnen';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min geleden`;
  const u = Math.floor(m / 60);
  if (u < 24) return `${u} uur ${m % 60} min geleden`;
  const d = Math.floor(u / 24);
  return `${d} dag${d === 1 ? '' : 'en'} ${u % 24} uur geleden`;
}


/**
 * Cachebreker voor bestanden die veranderen.
 *
 * GitHub Pages zet `Cache-Control: max-age=600` op alles, terwijl de Pi elke
 * twee minuten publiceert. Erger dan tien minuten oude cijfers: een gloednieuw
 * dagbestand blijft onzichtbaar zolang de browser een oude `index.json`
 * vasthoudt waarin die dag nog niet staat. Precies dat gebeurde op 05-08 — de
 * pagina meldde "nog geen gegevens ontvangen" terwijl de boot gewoon publiceerde.
 *
 * Per minuut afgerond: nieuw genoeg om bij te blijven, grof genoeg om de cache
 * binnen een minuut nog zijn werk te laten doen.
 */
const breker = () => `?t=${Math.floor(Date.now() / 60000)}`;

/** De dag waar we nu in zitten, in dezelfde vorm als de bestandsnamen. */
const vandaag = () => new Date().toISOString().slice(0, 10);

/** Haal de historie op uit de gepubliceerde dagbestanden. */
export async function haalHistorie(uren, fetchFn = fetch, basis = 'data') {
  let index;
  try {
    const res = await fetchFn(`${basis}/index.json${breker()}`);
    if (!res.ok) return [];
    index = await res.json();
  } catch (e) { return []; }

  const dagen = dagenVoorVenster(index && index.dagen, uren);
  const nuDag = vandaag();
  const delen = await Promise.all(dagen.map(async (d) => {
    try {
      // Alleen de dag van vandaag groeit nog; de rest ligt vast en mag uit de
      // cache komen. Anders haalt elke vensterwissel dertig bestanden opnieuw op.
      const res = await fetchFn(`${basis}/dag-${d}.jsonl${d >= nuDag ? breker() : ''}`);
      return res.ok ? parseJsonl(await res.text()) : [];
    } catch (e) { return []; }
  }));

  const grens = Date.now() - uren * 3600 * 1000;
  return delen.flat().filter((m) => m.t >= grens).sort((a, b) => a.t - b.t);
}

/** De laatste stand: waarden, schepen en het camerabeeld. */
export async function haalNu(fetchFn = fetch, basis = 'data') {
  try {
    const res = await fetchFn(`${basis}/nu.json${breker()}`);
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}

/**
 * Het volledige gevaren spoor sinds het begin, los van het tijdvenster.
 * Regels zijn [t_seconden, lat, lon]; hier omgezet naar dezelfde vorm als
 * trackVan() oplevert, zodat trackStukken() er zonder omweg mee werkt.
 */
export async function haalSpoor(fetchFn = fetch, basis = 'data') {
  try {
    const res = await fetchFn(`${basis}/spoor.json${breker()}`);
    if (!res.ok) return [];
    const body = await res.json();
    if (!Array.isArray(body && body.spoor)) return [];
    return body.spoor
      .filter((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))
      .map(([t, lat, lon]) => ({ t: t * 1000, lat, lon }));
  } catch (e) { return []; }
}

/**
 * De geüploade GPX-routes. Bestaat het bestand niet, dan zijn er simpelweg geen
 * routes — dat is geen fout en mag de rest van de kaart niet tegenhouden.
 */
export async function haalRoutes(fetchFn = fetch, basis = 'data') {
  try {
    const res = await fetchFn(`${basis}/routes.json${breker()}`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body && body.routes) ? body.routes.filter(bruikbaar) : [];
  } catch (e) { return []; }
}

/**
 * Het foto-archief: data/fotos.json is per dag een lijst bestandsnamen als
 * `UUMMSS.jpg`. Hier maken we er losse momenten van, chronologisch.
 *
 * De tijd zit in de naam en niet in het bestand, dus die lezen we eruit. Een
 * naam die daar niet aan voldoet slaan we over — één rare bestandsnaam mag de
 * hele galerij niet kosten.
 */
export async function haalFotos(fetchFn = fetch, basis = 'data') {
  try {
    const res = await fetchFn(`${basis}/fotos.json${breker()}`);
    if (!res.ok) return [];
    const body = await res.json();
    return fotoMomenten(body && body.dagen);
  } catch (e) { return []; }
}

/**
 * {dag: [ {naam,t,lat,lon} | "naam.jpg" ]} -> [{t, dag, naam, pad, lat?, lon?}].
 *
 * Sinds 08-08-2026 legt de Pi tijd en positie bij elke foto vast, in
 * epochseconden — dan is er geen tijdzone om over te struikelen en hoeft de
 * plaats niet uit het spoor geraden te worden. Oudere foto's staan er nog als
 * kale bestandsnaam in; voor die valt dit terug op de tijd uit de naam, en die
 * lezen we in de zone van de kijker. Dat kán ernaast zitten, en dat is precies
 * waarom het nu aan de bron gebeurt.
 */
export function fotoMomenten(dagen) {
  const uit = [];
  Object.entries(dagen || {}).forEach(([dag, lijst]) => {
    if (!Array.isArray(lijst)) return;
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dag);
    if (!d) return;
    lijst.forEach((post) => {
      const naam = typeof post === 'string' ? post : (post && post.naam);
      if (!naam) return;
      const m = /^(\d{2})(\d{2})(\d{2})\.jpg$/i.exec(String(naam));
      if (!m) return;

      let t = typeof post === 'object' && Number.isFinite(post.t)
        ? post.t * 1000
        : new Date(+d[1], +d[2] - 1, +d[3], +m[1], +m[2], +m[3]).getTime();
      if (!Number.isFinite(t)) return;

      const post_ = { t, dag, naam, pad: `foto/${dag}/${naam}` };
      if (typeof post === 'object'
          && Number.isFinite(post.lat) && Number.isFinite(post.lon)) {
        post_.lat = post.lat;
        post_.lon = post.lon;
      }
      uit.push(post_);
    });
  });
  return uit.sort((a, b) => a.t - b.t);
}

/**
 * Waar was de boot toen deze foto gemaakt werd?
 *
 * Het dichtstbijzijnde spoorpunt in tijd, maar alleen als dat dichtbij genoeg
 * ligt. Een foto van vandaag bij een spoorpunt van gisteren plakken zou een
 * plaats suggereren die we niet weten.
 */
export function plaatsVanFoto(spoor, t, maxAfwijkingMs = 20 * 60 * 1000) {
  if (!spoor || !spoor.length) return null;
  const p = monsterOp(spoor, t);
  if (!p || Math.abs(p.t - t) > maxAfwijkingMs) return null;
  return { lat: p.lat, lon: p.lon };
}

/**
 * Gelijkmatig uitdunnen tot er hooguit *maximum* over zijn.
 *
 * Op de kaart worden honderden merktekens een grijze massa waarin je niets meer
 * ziet. Begin en eind blijven staan, want die dragen betekenis.
 */
export function spreid(lijst, maximum) {
  if (!lijst || lijst.length <= maximum) return lijst || [];
  const stap = (lijst.length - 1) / (maximum - 1);
  const uit = [];
  for (let i = 0; i < maximum; i++) uit.push(lijst[Math.round(i * stap)]);
  return uit;
}

/** Een route is bruikbaar als er echt punten in zitten die je kunt tekenen. */
function bruikbaar(r) {
  return r && Array.isArray(r.punten) && r.punten.length > 0
    && r.punten.every((p) => Array.isArray(p) && p.length === 2
      && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}
