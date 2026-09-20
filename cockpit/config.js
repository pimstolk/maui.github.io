// Gegenereerd door scripts/build_cloud_site.sh — leest de PUBLIEKE Adafruit-feeds.
// Bevat geen geheim: de gebruikersnaam is openbaar, de schrijfsleutel blijft op de Pi.
// 'anker' is de snelle bron van de ankerwacht: een eigen tak, buiten Pages om,
// elke vier minuten vers. Zie scripts/publiceer.py bij ANKER_S.
// 'kijk' is de poortwachter voor het live meekijken (renogy_dashboard/kijk.py),
// via Tailscale Funnel. Alleen open als Pim de schakelaar aanzet.
window.RENOGY_CONFIG = { mode: 'cloud', bron: 'github', data: 'data',
  anker: 'https://raw.githubusercontent.com/pimstolk/maui.github.io/anker/data/anker.json',
  kijk: 'https://maui-pi.taile30cba.ts.net' };
