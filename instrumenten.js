// Twee ronde instrumenten voor het volgdashboard: een windroos en een kompas.
//
// Zelf getekend in SVG, als pure functies zonder DOM, zodat node ze kan toetsen.
// Bij hoeken is de kans op een stille fout groot — een instrument dat er prima
// uitziet en de verkeerde kant op wijst — dus de omrekening zit in punt() en die
// heeft zijn eigen test.
//
// Kleuren komen uit de kaartentafel: zandgeel voor de kaart zelf, magenta voor
// het gekozen moment, teal voor de wind (dezelfde kleur als in de windgrafiek).

const R = 100;                       // straal in gebruikerseenheden; viewBox is -120..120

/** Graden (0 = noord, met de klok mee) naar x/y met noord boven. */
export function punt(graden, straal) {
  const rad = ((graden - 90) * Math.PI) / 180;
  return { x: Math.cos(rad) * straal, y: Math.sin(rad) * straal };
}

export function windZijde(awa) {
  if (awa === null || awa === undefined) return '—';
  const a = Math.round(awa);
  if (a === 0) return 'recht vooruit';
  if (Math.abs(a) === 180) return 'recht van achteren';
  return a > 0 ? 'stuurboord' : 'bakboord';
}

const nr = (v) => Number(v).toFixed(1);

/** Ring met streepjes; elke 30° een lange, daartussen korte. */
function ticks() {
  let uit = '';
  for (let g = 0; g < 360; g += 10) {
    const lang = g % 30 === 0;
    const a = punt(g, lang ? R - 14 : R - 7);
    const b = punt(g, R);
    uit += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" `
         + `x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" `
         + `stroke="var(--ondiep)" stroke-opacity="${lang ? .45 : .2}" `
         + `stroke-width="${lang ? 2 : 1}" />`;
  }
  return uit;
}

function hoofdstreken() {
  return ['N', 'O', 'Z', 'W'].map((s, i) => {
    const p = punt(i * 90, R - 30);
    return `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" `
         + `dominant-baseline="central" font-family="var(--data)" font-size="13" `
         + `fill="var(--ondiep)" fill-opacity=".7">${s}</text>`;
  }).join('');
}

const omhulsel = (inhoud, label) =>
  `<svg viewBox="-120 -120 240 240" role="img" aria-label="${label}">`
  + `<circle r="${R}" fill="none" stroke="var(--lijn-sterk)" stroke-width="1.5" />`
  + inhoud + '</svg>';

/** De boot, altijd met de neus omhoog: de windroos staat relatief aan het schip. */
const bootje =
  '<path d="M0,-46 C13,-24 17,4 15,34 L-15,34 C-17,4 -13,-24 0,-46 Z" '
  + 'fill="var(--ondiep)" fill-opacity=".10" stroke="var(--ondiep)" '
  + 'stroke-opacity=".55" stroke-width="1.5" />';

/**
 * Windroos: het schip staat stil met de neus omhoog, de pijl wijst naar de kant
 * waar de wind vandaan komt. Zo lees je in één blik of je aan de wind ligt.
 */
export function windroosSvg(awa, aws) {
  let uit = ticks() + hoofdstreken() + bootje;

  if (awa !== null && awa !== undefined) {
    // Eén pijl, gedraaid over de hoek — makkelijker te toetsen dan losse punten.
    uit += `<g id="windpijl" transform="rotate(${Number(awa).toFixed(1)})">`
         + `<line x1="0" y1="-88" x2="0" y2="-30" stroke="var(--wind)" stroke-width="3" `
         + `stroke-linecap="round" />`
         + `<path d="M0,-26 L-7,-40 L7,-40 Z" fill="var(--wind)" />`
         + `</g>`;
  }

  const waarde = aws === null || aws === undefined ? '—' : nr(aws);
  uit += `<text x="0" y="-2" text-anchor="middle" font-family="var(--data)" `
       + `font-size="34" fill="var(--inkt)">${waarde}</text>`
       + `<text x="0" y="18" text-anchor="middle" font-family="var(--data)" `
       + `font-size="10" letter-spacing="2" fill="var(--inkt-vaag)">KNOPEN</text>`;

  return omhulsel(uit, 'Windroos');
}

/**
 * Kompas: noord blijft boven, de naald wijst de kompaskoers. De grondkoers krijgt
 * een eigen dun merkteken, want die twee lopen uiteen zodra er stroom staat —
 * en juist dat verschil is het interessante.
 */
export function kompasSvg(hdg, cog) {
  let uit = ticks() + hoofdstreken();

  if (cog !== null && cog !== undefined) {
    uit += `<g id="cogmerk" transform="rotate(${Number(cog).toFixed(1)})">`
         + `<line x1="0" y1="-100" x2="0" y2="-78" stroke="var(--sog)" stroke-width="3" `
         + `stroke-linecap="round" />`
         + `</g>`;
  }

  if (hdg !== null && hdg !== undefined) {
    uit += `<g id="naald" transform="rotate(${Number(hdg).toFixed(1)})">`
         + `<path d="M0,-72 L11,26 L0,14 L-11,26 Z" fill="var(--overprint)" `
         + `fill-opacity=".9" />`
         + `</g>`;
  }

  const waarde = hdg === null || hdg === undefined ? '—' : `${Math.round(hdg)}`;
  uit += `<circle r="34" fill="var(--zee)" stroke="var(--lijn-sterk)" stroke-width="1" />`
       + `<text x="0" y="-2" text-anchor="middle" font-family="var(--data)" `
       + `font-size="30" fill="var(--inkt)">${waarde}</text>`
       + `<text x="0" y="17" text-anchor="middle" font-family="var(--data)" `
       + `font-size="9" letter-spacing="2" fill="var(--inkt-vaag)">GRADEN</text>`;

  return omhulsel(uit, 'Kompas');
}
