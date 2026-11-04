/**
 * Wecker für die Podcast-Analyse auf GitHub
 * ---------------------------------------------------------------------------
 * Warum es diese Datei gibt: GitHub startet geplante Läufe nur "nach
 * Möglichkeit". Für dieses Repository kamen sie Stunden zu spät oder gar
 * nicht - am 4.11. ist zwischen 23:30 und 9:00 kein einziger von 15
 * geplanten Morgenläufen gestartet. Dann fehlen in der App Schnitt und
 * Sprungmarken, und es greift nur die grobe Notlösung.
 *
 * Google-Zeitauslöser dagegen laufen verlässlich (der DLF-Abruf in Code.gs
 * hängt seit Wochen daran). Diese Datei lässt Google die Analyse auf GitHub
 * anstossen. Ein von Hand angestossener Lauf startet sofort, ohne
 * Warteschlange.
 *
 * Einrichten (einmalig):
 *   1. Diese Datei im Apps-Script-Projekt als neue Datei "Wecker" anlegen
 *      (Dateien -> + -> Skript) und den Inhalt hineinkopieren.
 *   2. Projekteinstellungen -> Script Properties -> GITHUB_TOKEN anlegen.
 *      Der Token: github.com -> Settings -> Developer settings ->
 *      Fine-grained tokens -> nur Repository obitusde/podcasts,
 *      Berechtigung "Actions: Read and write". Sonst nichts.
 *   3. Oben die Funktion "weckerEinrichten" wählen und einmal ausführen.
 *      Sie legt die Zeitauslöser an und stösst zur Probe gleich einen
 *      Lauf an. Eine erneute Bereitstellung ist NICHT nötig - Zeitauslöser
 *      hängen nicht an der Web-App.
 */

var WECKER_REPO = 'obitusde/podcasts';
var WECKER_WORKFLOW = 'analyze.yml';

// Uhrzeiten (deutsche Zeit). Google hält sie auf etwa 15 Minuten genau ein.
// 6:20 holt Handelsblatt (erscheint 5:52-5:57) und HeuteMorgen (6:00);
// 7:00 ist das Netz, falls der erste Lauf zu früh kam. 19:00 holt Echo der
// Zeit (18:00). Schon analysierte Folgen kosten nichts - der Lauf sieht
// "schon analysiert" und endet nach dem Feed-Abruf.
var WECKER_ZEITEN = [
  { stunde: 6, minute: 20 },
  { stunde: 7, minute: 0 },
  { stunde: 19, minute: 0 }
];

function weckeAnalyse() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN fehlt in den Script Properties');

  var url = 'https://api.github.com/repos/' + WECKER_REPO +
    '/actions/workflows/' + WECKER_WORKFLOW + '/dispatches';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: 'main' }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code !== 204) {
    // 401: Token falsch oder abgelaufen. 403/404: Token darf "Actions" nicht.
    throw new Error('GitHub antwortet ' + code + ': ' + res.getContentText().slice(0, 300));
  }
  Logger.log('Analyse auf GitHub angestossen');
}

function weckerEinrichten() {
  // Alte Auslöser dieser Funktion entfernen, damit nichts doppelt läuft.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weckeAnalyse') ScriptApp.deleteTrigger(t);
  });

  WECKER_ZEITEN.forEach(function (z) {
    ScriptApp.newTrigger('weckeAnalyse')
      .timeBased()
      .everyDays(1)
      .atHour(z.stunde)
      .nearMinute(z.minute)
      .inTimezone('Europe/Berlin')
      .create();
  });
  Logger.log('Zeitauslöser angelegt: ' + WECKER_ZEITEN.map(function (z) {
    return z.stunde + ':' + (z.minute < 10 ? '0' : '') + z.minute;
  }).join(', '));

  // Probelauf: Klappt das, ist der Token richtig.
  weckeAnalyse();
}
