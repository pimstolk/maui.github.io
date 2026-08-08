// Een simpel slot op de voordeur.
//
// Wat dit wél doet: iemand die de link toevallig heeft, ziet niet meteen waar de
// boot ligt, en zoekmachines laten we de pagina niet indexeren.
//
// Wat dit NIET doet: de databestanden (data/nu.json en de dagbestanden) blijven
// direct opvraagbaar voor wie dat adres kent, en het antwoord staat gewoon in
// deze broncode. Dit is een drempel, geen beveiliging — bewust zo gekozen.
//
// Puur, zodat node het kan testen.

export const VRAAG = 'Wat is de thuishaven van Maui?';
const ANTWOORD = 'volendam';
const SLEUTEL = 'maui-poort';

/** Losjes vergelijken: hoofdletters, spaties en accenten mogen niet uitmaken. */
export function klopt(antwoord) {
  return normaliseer(antwoord) === ANTWOORD;
}

export function normaliseer(tekst) {
  return String(tekst || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')      // accenten eraf: Volendám telt ook
    .replace(/\s+/g, '');
}

/** Onthouden, zodat familie het maar één keer hoeft te typen. */
export function onthoud(opslag) {
  try { opslag.setItem(SLEUTEL, ANTWOORD); } catch (e) { /* privémodus */ }
}

export function magBinnen(opslag) {
  try { return opslag.getItem(SLEUTEL) === ANTWOORD; } catch (e) { return false; }
}

export function vergeet(opslag) {
  try { opslag.removeItem(SLEUTEL); } catch (e) { /* niets aan te doen */ }
}
