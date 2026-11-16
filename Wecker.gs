/**
 * Alter Wecker - abgeschaltet
 * ---------------------------------------------------------------------------
 * Früher stiessen Zeitauslöser um 6:20, 7:00 und 19:00 die Analyse auf GitHub
 * an. Das gibt es nicht mehr: Die Analyse kostet Geld und läuft jetzt nur
 * noch, wenn man in der App "Ja" tippt (siehe handleAnalyseAnfrage in
 * Code.gs und README, Abschnitt "Analyse auf Anfrage").
 *
 * Diese Datei ist nur noch zum Aufräumen da:
 *   - Wer die alte Fassung im Apps Script hat, muss nichts tun: Ihre
 *     Zeitauslöser rufen den Workflow weiter ohne "anfrage" auf, und der
 *     Workflow überspringt diesen Aufruf ohne Kosten.
 *   - Wer ganz aufräumen will: Diese Fassung einfügen, die Funktion
 *     "weckerEntfernen" einmal ausführen (löscht die alten Zeitauslöser),
 *     danach die Datei "Wecker" im Projekt löschen.
 *
 * Der Token (Script Property GITHUB_TOKEN) bleibt wichtig: Code.gs braucht
 * ihn, um die Analyse auf Anfrage anzustossen.
 */

// Wird von alten Zeitauslösern noch aufgerufen und tut nichts mehr.
function weckeAnalyse() {
  Logger.log('Automatische Analyse ist abgeschaltet - sie läuft nur noch auf Anfrage aus der App.');
}

// Löscht die alten Zeitauslöser des Weckers.
function weckerEntfernen() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weckeAnalyse') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  Logger.log(n + ' Zeitauslöser des Weckers gelöscht.');
}
