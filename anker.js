// De ankerwacht op de volgpagina: waar ligt het anker, waar ligt de boot, en
// hoe oud is dat.
//
// De Pi zet `anker.json` elke vier minuten op een eigen tak van de repo, en de
// pagina haalt hem rechtstreeks van raw.githubusercontent.com: zo hoeft GitHub
// Pages niet elke vier minuten te bouwen. Valt dat bron weg, dan is er de
// kopie naast de site uit de gewone ronde (ouder, maar beter dan niets).
//
// Puur en zonder DOM waar het kan, zodat node het kan toetsen.

const breker = () => `?t=${Math.floor(Date.now() / 60000)}`;

/** Het bestand ophalen: eerst de snelle bron, dan de kopie naast de site. */
export async function haalAnker(fetchFn = fetch, bronnen = ['data/anker.json']) {
  for (const bron of bronnen) {
    if (!bron) continue;
    try {
      const res = await fetchFn(`${bron}${breker()}`);
      if (!res.ok) continue;
      const a = await res.json();
      if (a && typeof a === 'object' && 'actief' in a) return a;
    } catch (e) { /* volgende bron */ }
  }
  return null;
}

export function meterTussen(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
  const x = Math.sin(dlat / 2) ** 2
          + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** De spoorpunten als objecten, met alleen wat geldig is. */
export function spoorVan(a) {
  return ((a && a.spoor) || [])
    .filter((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))
    .map(([t, lat, lon]) => ({ t, lat, lon }));
}

/**
 * Alles wat het ankervak nodig heeft, in getallen en woorden.
 *
 * `status`: 'uit' (geen anker), 'rust', 'buiten' (krabt) of 'geenfix'. De
 * versheid gaat over het bestand zelf: staat het er langer dan tien minuten,
 * dan is de Pi kennelijk stil en zegt het vak dat eerlijk.
 */
export function ankerSamenvatting(a, nuMs = Date.now()) {
  if (!a || !a.actief) return { status: 'uit' };
  const nuS = nuMs / 1000;
  const oudS = a.t ? Math.max(0, nuS - a.t) : null;
  let status = 'rust';
  if (a.alarm) status = a.reden === 'geen fix' ? 'geenfix' : 'buiten';
  const positie = a.positie && Number.isFinite(a.positie.lat) ? a.positie : null;
  return {
    status,
    afstand: a.afstand_m == null ? null : Math.round(a.afstand_m),
    straal: a.straal_m == null ? null : Math.round(a.straal_m),
    max: a.max_afstand_m == null ? null : Math.round(a.max_afstand_m),
    peiling: a.peiling,
    sinds: a.gezet_op ? a.gezet_op * 1000 : null,
    positie,
    positieT: positie && positie.t ? positie.t * 1000 : null,
    bestandT: a.t ? a.t * 1000 : null,
    oudS,
    stil: oudS !== null && oudS > 10 * 60,
    alarmSinds: a.alarm_sinds ? a.alarm_sinds * 1000 : null,
    bron: a.bron || null,
  };
}

/**
 * Het positielogboek: één regel per *stapS* seconden, nieuwste bovenaan, met
 * voor elke regel de tijd, de positie en de afstand tot het anker. Dit is de
 * lijst met tijdstempels die Pim expliciet vroeg -- het spoor op de kaart laat
 * zien wáár, deze lijst wannéér.
 */
export function logboek(a, stapS = 600, maxRijen = 18) {
  if (!a || !a.actief || !Number.isFinite(a.lat)) return [];
  const anker = { lat: a.lat, lon: a.lon };
  const punten = spoorVan(a);
  const uit = [];
  let laatst = Infinity;
  for (let i = punten.length - 1; i >= 0 && uit.length < maxRijen; i--) {
    const p = punten[i];
    if (laatst - p.t < stapS && i !== punten.length - 1) continue;
    uit.push({ t: p.t * 1000, lat: p.lat, lon: p.lon,
               afstand: Math.round(meterTussen(anker, p)) });
    laatst = p.t;
  }
  return uit;
}

/**
 * Het zwaaispoor in lagen op leeftijd, voor de kaart: ouder is vager. Elke
 * laag is een aaneengesloten stuk lijn; de overgang tussen twee lagen deelt
 * een punt, zodat de lijn niet breekt.
 */
export function spoorOpLeeftijd(a, nuS = Date.now() / 1000) {
  const punten = spoorVan(a);
  if (punten.length < 2) return [];
  const grenzen = [[Infinity, 6 * 3600, .2], [6 * 3600, 3600, .4], [3600, 900, .65], [900, 0, .95]];
  const lagen = [];
  grenzen.forEach(([van, tot, opacity]) => {
    const deel = [];
    punten.forEach((p, i) => {
      const oud = nuS - p.t;
      const erin = oud < van && oud >= tot;
      // Het eerste punt ná de laag hoort er ook bij, zodat de lijn doorloopt.
      const vorigeErin = i > 0 && (nuS - punten[i - 1].t) < van && (nuS - punten[i - 1].t) >= tot;
      if (erin || (vorigeErin && !erin && oud < tot)) deel.push([p.lat, p.lon]);
    });
    if (deel.length >= 2) lagen.push({ punten: deel, opacity });
  });
  return lagen;
}
