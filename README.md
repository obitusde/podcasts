# Podcasts – Neueste Folgen

Eine kleine, selbst gehostete Podcast-Startseite: zeigt pro konfiguriertem Podcast
die neueste(n) Folge(n) als Kachel, spielt sie im Browser ab und merkt sich Fortschritt,
gehörte Folgen und die Position beim Zurückblättern – alles im `localStorage` des Geräts.

Gehostet auf GitHub Pages, mit einem Google Apps Script als Backend/Proxy.

## Warum ein Backend nötig ist

Podcast-RSS-Feeds (SRF, Deutschlandfunk, Handelsblatt, …) setzen in der Regel keine
CORS-Header. Das heisst: `fetch()` direkt aus dem Browser (von einer GitHub-Pages-Domain
aus) auf so einen Feed schlägt fehl. Der Apps-Script-Proxy (`Code.gs`) holt den Feed
stattdessen serverseitig, parst ihn und liefert die letzten Episoden als CORS-freies JSON.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Die eigentliche Seite: Podcast-Kacheln, Player, gesamte Logik |
| `Code.gs` | Google Apps Script Web-App: RSS-Proxy, liefert JSON |
| `manifest.json` | Web App Manifest, macht die Seite auf Android als PWA installierbar |
| `sw.js` | Minimaler Service Worker (App-Shell-Cache, nötig für PWA-Installierbarkeit) |
| `icon-192.png` / `icon-512.png` | App-Icons für Homescreen/Manifest |

## Setup

### 1. Backend deployen (einmalig)

1. Neues Projekt auf [script.google.com](https://script.google.com) anlegen.
2. Inhalt von `Code.gs` einfügen.
3. **Bereitstellen → Neue Bereitstellung → Typ: Web-App**
   - Ausführen als: *Ich*
   - Zugriff: *Jeder*
4. Die erzeugte `.../exec`-URL kopieren.

Bei künftigen Änderungen an `Code.gs`: **Bereitstellen → Bereitstellungen verwalten →
Version aktualisieren** (nicht neu bereitstellen, sonst ändert sich die URL).

### 2. Frontend konfigurieren

In `index.html` ganz oben im `<script>`-Block:

```javascript
const PROXY_URL = "https://script.google.com/macros/s/DEINE_ID/exec";
```

### 3. Hosten

Alle fünf Dateien (`index.html`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`)
ins Repo, GitHub Pages aktivieren (Settings → Pages → Branch `main` / `root`).

Auf dem Handy (Chrome/Android): Seite öffnen → Menü → **Zum Startbildschirm hinzufügen**,
dann als App (nicht als Browser-Tab) nutzen – das gibt die zuverlässigste
Hintergrund-Wiedergabe.

## Einen Podcast hinzufügen

Im `PODCASTS`-Array in `index.html` einen Eintrag ergänzen:

```javascript
const PODCASTS = [
  {
    name: "HeuteMorgen",
    feed: "https://www.srf.ch/feed/podcast/sd/179ababb-4b36-40b2-951d-92d5c207fe9f.xml"
  },
  // ... weitere Einträge ...
  {
    name: "Mein neuer Podcast",
    feed: "https://beispiel.de/mein-podcast-feed.xml"
  }
];
```

Nötig ist nur `name` (wird als Label auf der Kachel angezeigt) und `feed` (die
RSS-Feed-URL, **nicht** die HTML-Seite des Podcasts).

### Feed-URL finden

Auf der Podcast-Seite nach "Abonnieren" / "Feed-URL kopieren" suchen. Bei Podigee-,
Podbean- oder Deutschlandfunk-Podcasts lässt sie sich oft auch über den
Apple-Podcasts-Link herleiten oder direkt im Quelltext der Seite finden
(`<atom:link rel="self" ... href="...">` im Feed selbst, oder ein `<link>`-Tag mit
`type="application/rss+xml"` auf der HTML-Seite).

### Optional: nur lange Ausgaben (Filter nach Dauer)

Manche Feeds (z. B. stündliche Nachrichten) mischen kurze und lange Ausgaben. Mit
`minDurationSeconds` werden alle kürzeren Episoden herausgefiltert:

```javascript
{
  name: "DLF Nachrichten (lang)",
  feed: "https://www.deutschlandfunk.de/nachrichten-108.xml",
  minDurationSeconds: 420 // nur Ausgaben ab 7 Minuten
}
```

Der Wert lässt sich einfach durch Ausprobieren finden: Feed im Browser öffnen, Dauer
(`<itunes:duration>`) der Episoden anschauen, Schwelle so setzen, dass sie kurze und
lange Ausgaben sauber trennt.

### Optional: nur bestimmte Titel (Filter nach Text im Titel)

Manche Feeds mischen mehrere Autoren/Künstler in einem Feed, wobei jede Episode den
Namen im Titel trägt (z. B. `"Dieter Nuhr: ..."`, `"Fritz Eckenga: ..."` im WDR-2-
Kabarett-Feed). Mit `titleContains` lässt sich der Feed auf Episoden mit diesem Text
im Titel eingrenzen (Gross-/Kleinschreibung egal):

```javascript
{
  name: "Dieter Nuhr",
  feed: "https://www1.wdr.de/mediathek/audio/wdr2/wdr2-kabarett/kabarett-podcast-100.podcast",
  titleContains: "Dieter Nuhr"
}
```

Lässt sich mit `minDurationSeconds` kombinieren, wird aber selten gebraucht.

Das Gegenstück ist `titleExcludes`: schliesst Episoden mit diesem Text im Titel aus.
Damit lassen sich zwei komplementäre Kacheln aus demselben Feed bauen - eine "nur X",
eine "alle ausser X":

```javascript
{
  name: "WDR Kabarett",
  feed: "https://www1.wdr.de/mediathek/audio/wdr2/wdr2-kabarett/kabarett-podcast-100.podcast",
  titleExcludes: "Dieter Nuhr"
}
```

### Optional: Werbung am Anfang/Ende abschneiden

Podcasts mit fester Werbung vorne und hinten lassen sich zeitlich beschneiden. Die
Werte stehen als Konstanten in `index.html` im Block `PODCAST_TRIM` (direkt unter der
`PODCASTS`-Liste) und sind dort jederzeit von Hand änderbar:

```javascript
const PODCAST_TRIM = {
  "Handelsblatt Morning Briefing": {
    startSeconds: 1 * 60 + 15,  // 1:15 - davor Werbung
    endSeconds:   9 * 60 + 5    // 9:05 - danach Werbung
  }
};
```

- Der Schlüssel muss exakt dem `name` in `PODCASTS` entsprechen.
- `startSeconds: 0` bzw. `endSeconds: null` heisst "nicht abschneiden".
- Beim Erreichen von `endSeconds` wird pausiert und die Folge genauso behandelt wie
  am echten Dateiende: sie gilt als gehört, die Kachel zeigt die nächstältere Folge,
  und die Autoplay-Modi spielen weiter.
- Die `-10s`/`+30s`-Tasten springen nicht in die abgeschnittenen Bereiche hinein.
- Die Dauer-Anzeige auf der Kachel kommt weiterhin aus dem Feed, zeigt also die
  ungekürzte Länge.

## Verhalten des Players

### Kacheln / Episoden-Navigation

- Jede Kachel zeigt standardmässig die **neueste** Folge des jeweiligen Podcasts.
- **Klick auf eine inaktive Kachel:** spielt die dort angezeigte Folge ab.
- **Klick auf die bereits aktive Kachel, während die Folge noch läuft oder pausiert
  ist** (also nicht von selbst zu Ende gelaufen): springt sofort eine Folge weiter
  zurück (älter) und spielt sie automatisch ab. Wiederholtes Klicken blättert so durch
  die Historie (bis zu 15 Folgen werden pro Podcast vom Backend geladen).
- **Wenn eine Folge von selbst zu Ende läuft** (`ended`-Event): Die Kachel rückt die
  Anzeige automatisch auf die nächstältere Folge vor (Titel/Datum aktualisieren sich),
  aber es **spielt nichts von selbst weiter**. Erst ein erneuter Klick startet die
  Wiedergabe dieser Folge.
- **Neue Folge im Feed seit dem letzten Besuch?** Die Kachel springt automatisch auf
  die neueste Folge zurück, unabhängig davon, wo man vorher stand.

### Gespeicherter Zustand (`localStorage`, pro Gerät/Browser)

Für jeden Podcast wird gespeichert:
- welche Folge zuletzt als "neueste bekannte" galt (für den Reset bei neuen Folgen),
- die aktuelle Position beim Zurückblättern,
- Wiedergabefortschritt pro Folge (zum Fortsetzen an der Stelle, wo man aufgehört hat),
- welche Folgen als "gehört" markiert sind (ab 95 % Hörzeit oder nach `ended`).

### Bedienung

Die Player-Leiste ist bewusst selbst gebaut (die nativen `<audio controls>` sind auf
dem Handy zu klein und lassen sich nicht vergrössern):

- **Fortschrittsbalken** mit verstrichener Zeit links und Restzeit rechts. Beides
  bezieht sich auf den hörbaren Bereich - weggeschnittene Werbung (`PODCAST_TRIM`)
  zählt nicht mit.
- **Grosser runder Play/Pause-Knopf** (66 px) in der Mitte, flankiert von
  `◀ älter` / `neuer ▶` für die Folgen-Navigation innerhalb desselben Podcasts.
- Sprung-Zeile: `-10s`, `-5s`, `+5s`, `+10s`, `+30s` - diese Sprünge bleiben
  innerhalb des getrimmten Bereichs.
- **Tempo-Knopf**: schaltet beim Tippen reihum durch `1,0×` / `1,1×` / `1,2×` und
  merkt sich die Wahl (`localStorage`). Die Liste steht als `SPEEDS` in `index.html`.
- **Eigene Hintergrundfarbe** (`--player-bg`, deutlich heller als Seite und Kacheln)
  plus Schatten nach oben, damit die Leiste klar von der Podcast-Liste absteht.
- **Ausblenden:** Wischt man nach oben (um einen anderen Podcast auszusuchen), fährt
  die Leiste weg - und bleibt weg, auch beim Weiterscrollen. Die Wiedergabe läuft
  dabei weiter.
- **`×`-Knopf:** blendet die Leiste aus **und hält die Wiedergabe an** (Position
  wird gemerkt).
- **Zurückholen:** Tipp auf die *laufende* Kachel holt die Leiste zurück, ohne eine
  Folge weiterzublättern; war mit `×` angehalten worden, läuft es an derselben
  Stelle weiter. Tipp auf eine *andere* Kachel startet diesen Podcast.
- **Hover nur mit Maus:** Alle Hover-Effekte stehen in einer
  `@media (hover: hover)`-Regel. Ohne das blieb auf dem Handy nach einem Tap ein
  klebender :hover zurück (Knöpfe dauerhaft orange, aktiver Modus-Knopf unlesbar).
- **Media Session API**: externe Bedienung über Sperrbildschirm, Kopfhörer oder
  Auto-Bedienelemente funktioniert:
  - Play/Pause steuern die Wiedergabe direkt.
  - "Zurückspulen"/"Vorspulen" (z. B. auf dem Sperrbildschirm) sind fest auf **-5s /
    +10s** gelegt.
  - "Vorheriger/Nächster Titel" (z. B. Lenkradtasten) springt zur nächstälteren bzw.
    nächstneueren geladenen Folge und spielt sie sofort ab.
  - Position und Länge werden gemeldet (`setPositionState`), ebenfalls bezogen auf
    den getrimmten Bereich; Scrubben von aussen (`seekto`) wird umgerechnet.
  - Titel, Podcast-Name und Cover werden ans Betriebssystem übergeben. Ob das
    **Autoradio** das Cover anzeigt, hängt vom Bluetooth-Profil des Radios ab
    (Cover-Art gibt es erst ab AVRCP 1.6); Titel und Name kommen praktisch überall an.
- **Aktualisieren-Knopf** (`↻` oben rechts): lädt alle Feeds neu, ohne die Seite neu
  zu laden - eine laufende Folge spielt weiter. Eine Kachel mit Ladefehler kann man
  direkt antippen, um sie allein erneut zu versuchen.
- **Wake Lock**: Der Bildschirm schläft nicht ein, solange die Seite sichtbar ist.
- Als installierte PWA sollte die Wiedergabe auch bei ausgeschaltetem Bildschirm
  weiterlaufen (abhängig vom Verhalten von Chrome/Android).

### Cover-Bilder (werden nur einmal pro Jahr geladen)

Pro Podcast wird die zuerst gesehene Cover-URL in `localStorage` (`podcastImages_v1`)
festgehalten und **ein Jahr lang** weiterverwendet, statt wie früher das Bild der
jeweiligen Episode zu nehmen. Dadurch bleibt die Bild-URL über neue Folgen hinweg
stabil, der Service-Worker-Cache (`sw.js`, cache-first für Bilder) greift, und im
Normalbetrieb lädt der Browser überhaupt kein Cover mehr nach. Die Dauer steht in
`index.html` als `IMAGE_MAX_AGE_MS`.

### Kachel-Layout und Titel

- Der Podcast-Name steht als eigene Zeile ganz oben links - also auch über dem
  Cover. Darunter folgt die Zeile mit Cover, Episodentitel und Datum.
  So stehen Name und Titel über die volle Kachelbreite zur Verfügung.
- `<main>` hat seitlich fast keinen Rand mehr, die Kacheln nutzen die Bildschirm-
  breite aus.
- Immer gleiche Titel-Vorsätze werden im Frontend abgeschnitten
  (`TITLE_PREFIXES_TO_STRIP` in `index.html`). Aktuell: "Die Nachrichten vom
  20.10.2026, 14:00 Uhr" wird zu "14:00 Uhr" (das Datum steht ohnehin eine Zeile
  tiefer). Weitere Muster lassen sich dort als reguläre Ausdrücke ergänzen.
- Wird eine Kachel umbenannt, trägt man das Paar in `RENAMED_PODCASTS` ein; dann
  ziehen Reihenfolge, Hörfortschritt und Cover beim nächsten Start automatisch auf
  den neuen Namen um, statt verloren zu gehen.

## Werbung überspringen und Themen (automatische Erkennung)

**Diese Erkennung läuft als GitHub Action** (`.github/workflows/analyze.yml`,
Skript `tools/analyze.mjs`), nicht im Apps Script. Grund: Am Repository kann
Claude selbst arbeiten - Prompt, Modelle, Podcast-Liste und Zeiten ändern sich
dadurch ohne Copy-Paste in den Apps-Script-Editor und ohne neue Bereitstellung.

Ablauf:

1. Die Action läuft morgens im Halbstundentakt (3:00-7:30 UTC) plus einmal
   mittags - so lange, bis die Folge des Tages erschienen und analysiert ist.
   Jeder weitere Lauf an dem Tag endet nach dem Feed-Abruf. Von Hand starten:
   *Actions → Podcast-Analyse → Run workflow*; mit angehaktem "force" werden
   auch schon analysierte Folgen neu ausgewertet.
2. `tools/analyze.mjs` liest die Feeds aus `tools/podcasts.config.json` und
   nimmt sich **nur die neueste Folge** (`episodes: 1`). Sie wird übersprungen,
   wenn sie schon analysiert wurde oder älter als `maxAgeHours` (Standard 14
   Stunden) ist - an Tagen ohne neue Folge passiert also nichts.
3. Pro neuer Folge: MP3 laden → OpenRouter-Transkription mit Wort-Zeitstempeln
   → Transkript in feine Zeilen (max. 8 Sek.) zerlegen → günstiges Textmodell
   benennt Werbeblöcke und Themen über **Zeilennummern** → die Sekunden kommen
   aus dem Transkript.
4. **Die Werbung wird herausgeschnitten.** ffmpeg kopiert die Stücke zwischen
   den Werbeblöcken zusammen (ohne Neuberechnung, also ohne Qualitätsverlust)
   und die fertige Datei wird als Anhang der Veröffentlichung `audio`
   abgelegt. Die Themenmarken werden auf die Zeitachse dieser Datei
   umgerechnet.
5. Ergebnis landet in `data/analysis.json` und wird von der Action committet.
   `index.html` lädt diese Datei beim Start (gleiche Adresse, kein CORS) und
   verknüpft sie über die `guid` mit den Folgen aus dem Feed. Gibt es eine
   geschnittene Fassung, spielt der Player sie; fehlt sie, fällt er auf die
   Originaldatei mit den festen Werten zurück.

### Wo die Themenerkennung an ihre Grenze stösst

Eine Marke pro Folge liegt gelegentlich daneben, und das ist kein Fehler,
den man wegprogrammiert. Bei Echo der Zeit pendelte die Marke für ein Thema
über sechs Läufe zwischen zwei Stellen: 19:02 (die Anmoderation im Studio)
und 19:35 (der Anfang des Beitrags). Beides ist eine vertretbare Antwort auf
"wo beginnt dieses Thema", und das Modell entscheidet sich mal so, mal so.

Messen hilft hier nicht weiter: Auch vor 18:18 liegt eine lange Pause - dort
bedankt sich die Moderation beim Korrespondenten. Eine lange Pause ist also
nicht gleichbedeutend mit einem Themenwechsel. Die Unterscheidung zwischen
"Abschluss des alten Themas" und "Ankündigung des neuen" ist inhaltlich,
nicht akustisch, und damit auf das Modell angewiesen.

Was dagegen hilft und eingebaut ist: Das Modell nennt Anmoderation und
Beitragsanfang getrennt (es muss sich also nicht entscheiden), die Antwort
wird auf brauchbare Anfangsworte geprüft und notfalls einmal nachgefragt,
und gesucht wird in einem Zeitfenster statt in einer festen Zahl von
Abschnitten. Damit sassen beim letzten Stand acht von neun Marken richtig.

Weiteres Nachschärfen am Prompt hat in beide Richtungen ausgeschlagen und
dabei Marken kaputtgemacht, die vorher sassen. Wer hier wieder ansetzt:
erst ein Testfall, dann die Änderung - nicht umgekehrt.

### Konfiguration: die Google-Tabelle

Welche Podcasts es gibt, in welcher Reihenfolge sie erscheinen und was mit
ihnen passiert, steht in einer Google-Tabelle im Drive des Nutzers - nicht
mehr im Code. Eine Zeile je Podcast, die Zeilenreihenfolge ist die
Reihenfolge in der App.

| Spalte | Bedeutung |
|---|---|
| ID | ändert sich nie; daran hängt der Hörfortschritt beim Umbenennen |
| Aktiv | nein = ausblenden, ohne die Zeile zu löschen |
| Name | Überschrift in der App |
| Feed-URL | Adresse des Feeds, oder `dlf_audio` für den Sonderfall |
| Nur Titel mit / Titel ohne | Folgenfilter |
| Mindestlänge (Sek.) | kürzere Folgen werden ausgeblendet |
| Werbung | ja = Werbung schneiden und die Datei bei GitHub ablegen |
| Sprungmarken | ja = Themen erkennen |
| Start / Ende (Sek.) | fester Vor- und Abspann |
| Aufbau | ein Satz über den Aufbau der Sendung, für die Erkennung |
| Werbemarker | Satz, mit dem die Werbung angekündigt wird; ab seinem Anfang wird geschnitten |
| Schlussmarker | ab hier gilt der Rest als Werbung |
| Folgen | wie viele der neuesten Folgen geprüft werden |
| Sammlung | ja = liefert Beiträge für die Tagesliste (siehe unten) |

Der Weg: `tools/sync-config.mjs` liest die im Web veröffentlichte Tabelle als
CSV und schreibt sie nach `data/config.json`; die App liest nur diese Datei.
Das passiert bei jedem Analyse-Lauf und zusätzlich auf Knopfdruck unter
*Actions → Konfiguration uebernehmen*. Die Adresse der Tabelle steht in
`tools/config-quelle.txt`.

Warum der Umweg über das Repository statt direkt aus dem Browser: Google
liefert Tabellen nicht verlässlich mit den Kopfzeilen aus, die ein Browser
für fremde Adressen verlangt; und wenn Google nicht antwortet, hätte die App
gar keine Podcastliste. So liegt die zuletzt funktionierende Fassung immer
unter derselben Adresse wie die App.

Zwei Dinge, die dabei leicht schiefgehen:

- **Zeiten.** Tippt man `9:05` in eine Zelle, macht Google daraus eine
  Uhrzeit und liefert `9:05:00` aus. Die Spalten heissen deshalb
  "(Sek.)" und erwarten Sekunden; `mm:ss` und Googles Uhrzeit-Form werden
  trotzdem richtig verstanden.
- **Umbenennen.** Gehört-Haken und Hörposition hängen am Namen. Die
  ID-Spalte fängt das ab: Weicht der Name von dem ab, der zuletzt zu dieser
  ID gespeichert war, zieht alles Gespeicherte mit um.

Die Reihenfolge wird ausschliesslich in der Tabelle festgelegt. Den früheren
Ziehgriff an der Kachel gibt es nicht mehr: Zwei Stellen für dieselbe Sache
widersprechen sich sonst ständig, und auf dem Handy war die Tabelle ohnehin
der bequemere Weg.

Fehlt `data/config.json` oder ist die Tabelle nicht erreichbar, gelten die
Listen im Code (`PODCASTS` in `index.html`, `tools/podcasts.config.json`).

### Die Sammlung: eine Tagesliste

Ganz unten steht eine Kachel, die sich wie ein Podcast verhält, deren
"Folgen" aber aus mehreren Feeds stammen: **alle** neuen Beiträge der
Podcasts, die in der Tabelle in der Spalte *Sammlung* auf ja stehen. Eine
Längengrenze gibt es nicht; was kurz genug ist, entscheidet die Auswahl der
Podcasts. Die Beiträge laufen nacheinander, mit zwei Sekunden Pause dazwischen.

- **Eine Liste je Tag.** Um 7:00 und um 15:00 wird sie *ergänzt*: Was
  seitdem erschienen ist, kommt ans Ende, die gemerkte Stelle bleibt. Was
  morgens ungehört blieb, ist mittags noch da. Erst am nächsten Morgen um
  7:00 beginnt eine neue Liste; die alte ist dann weg, auch Ungehörtes.
  Vor 7:00 gilt noch die Liste von gestern.
- **Reihenfolge:** älteste zuerst, wie der Tag verlaufen ist. Neues hängt
  hinten an.
- **Zeitfenster:** Aufgenommen wird, was seit gestern 15:00 erschienen ist.
  So kommt der Kommentar vom Vorabend mit, und früh erschienene Beiträge
  fehlen abends nicht.
- **Nichts doppelt.** Was einmal in einer Liste stand, kommt nicht wieder,
  auch nicht am nächsten Tag, wenn es noch im Feed hängt. Das Gedächtnis
  dafür reicht zwei Wochen zurück. (DLF Audiobeiträge entfernt zusätzlich
  im Apps Script dasselbe Thema aus verschiedenen Sendungen.)
- **Angestossen** wird die Ergänzung beim Öffnen der App oder beim
  Aktualisieren, sobald ein neuer Abschnitt begonnen hat; dazwischen bleibt
  die Liste unverändert. Fehlt dabei ein Feed (nicht geladen, ausgefallen),
  gilt der Abschnitt nicht als erledigt, und beim nächsten Mal wird
  nachgeholt, was fehlt.
- **Überspringen** geht mit dem Knopf in der Themenzeile und mit der
  Vorwärts-Taste am Bluetooth-Gerät; die Rückwärts-Taste geht einen Beitrag
  zurück. Beim Hören einer gewöhnlichen Folge bleiben diese Tasten wie
  bisher beim Blättern durch die Folgen.
- **Die Stelle wird gemerkt.** War die Liste bis zum Ende gehört und kommt
  Neues dazu, geht es beim ersten neuen Beitrag weiter.

Warum die Liste im Browser entsteht und nicht im Lauf auf GitHub: DLF
Audiobeiträge hat keinen gewöhnlichen Feed, sondern wird vom Apps Script
zusammengestellt (`type: dlf_audio`). Der Lauf käme da nicht heran. Die
Liste liegt deshalb im `localStorage` des Geräts, nicht im Repository; ein
zweites Gerät hat eine eigene Liste mit eigener Position.

**Dauer-Angaben** stehen in den Feeds je nach Quelle als `283`, `4:43` oder
`00:02:49`. Die erste Fassung der Sammlung hat sie als Zahl gelesen und
damit jeden Beitrag aus normalen Feeds verworfen. Die Sammlung liest die
Dauer jetzt gar nicht mehr.

### Warum geschnitten und nicht nur markiert wird

Podigee baut die Werbung bei **jedem Abruf neu** ein. An derselben Adresse
gemessen, innerhalb von zehn Minuten:

| Uhrzeit | Länge |
|---|---|
| 11:49 | 595 s |
| 11:52 | 506 s (ganz ohne Werbung) |
| 11:58 | 592 s |

Alle vier getesteten Adressvarianten (`?source=feed`, ohne Zusatz,
`?source=webplayer`, `?source=website`) lieferten jeweils dieselbe Datei wie
die anderen - es gibt also keine Adresse für eine feste Fassung. Zeitmarken,
die morgens um 6 gemessen werden, passen deshalb grundsätzlich nicht zu der
Datei, die das Handy um halb sieben lädt. Nachprüfen lässt sich das jederzeit
mit *Actions → Auslieferung pruefen*.

Von jedem Podcast bleibt nur die **neueste** geschnittene Folge liegen; sobald
die Ausgabe des nächsten Tages fertig ist, wird die vorherige gelöscht.

Einmalig nötig: Repository-Secret `OPENROUTER_API_KEY` unter
*Settings → Secrets and variables → Actions → New repository secret*.

Kosten: ca. 0,2 Cent Transkription plus ca. 0,1 Cent Analyse je Folge - also
nur an Tagen mit neuer Folge, einmal pro Folge.

Die Länge der Datei wird mit `ffprobe` gemessen, nicht aus dem Feed oder dem
Transkript abgeleitet: Der Feed meldet beim Handelsblatt rund 8:30, die Datei
läuft knapp 10 Minuten, und Whisper hängt am Dateiende gern noch ein paar
Sekunden an. Mit der falschen Länge fällt entweder der Werbeblock am Schluss
unter den Tisch oder der Abgleich im Player scheitert an einer Datei, die in
Wahrheit die richtige ist.

Reihenfolge der Quellen im Frontend: `data/analysis.json` → was der
Apps-Script-Proxy mitliefert → feste Werte aus `PODCAST_TRIM`. Die
entsprechende Logik in `Code.gs` ist damit nur noch Reserve und kann bei
Gelegenheit entfernt werden.

### Wie es früher gedacht war (Apps Script)

Für ausgewählte Podcasts (aktuell nur das Handelsblatt Morning Briefing, Liste
`AD_DETECT_PODCASTS` in `Code.gs`) analysiert das Backend die neuesten Folgen:

1. MP3 laden, an den Transkriptions-Endpunkt von OpenRouter schicken
   (`openai/whisper-large-v3-turbo`, ca. 0,2 Cent für 10 Minuten Audio).
2. Das Transkript mit Zeitstempeln an ein günstiges Textmodell geben. Das nennt
   die **Zeilennummern** der Werbeblöcke und der Themen - nicht die Sekunden.
   Die Sekunden setzt `Code.gs` selbst aus dem Transkript ein.
3. Ergebnis pro Folge speichern (`episodeAnalysis_v1`, die letzten 20 Folgen)
   und in `doGet` an die Episoden hängen: `adRanges` und `chapters`.

Der Umweg über die Zeilennummern ist der Kern: Lässt man ein Sprachmodell die
Audiodatei direkt anhören und nach Sekunden fragen, liegen die Werte weit daneben.

### Was beim Feinschliff gelernt wurde

Die Grenzen sitzen nur dann verlässlich, wenn sie **nicht** vom Sprachmodell
geschätzt werden. Drei Regeln arbeiten deshalb ohne Modell:

| Grenze | Regel |
|---|---|
| Ende eines Werbeblocks | bis zum ersten **echten** Wort danach (Jingle-Füllwörter wie "Musik" oder "Vielen Dank", die Whisper erfindet, zählen nicht) |
| Schlussblock | ab dem `endMarker` der Sendung (hier die Verabschiedung "Ihr Sven Prange") bis Dateiende |
| Themenanfang | zurück auf das Schlagwort davor ("Notenbanken.", "Audi.", "Börse.") - erkennbar daran, dass es für sich allein einen Satz bildet |

Ausserdem:

- **Transkriptionsmodell:** Whisper-Turbo setzte dasselbe Wort in drei Läufen
  auf 1:29, 1:34 und 1:37 - die Zeitstempel wackeln rund um Musik. Deshalb
  läuft die Transkription auf `openai/whisper-large-v3` (ca. 0,5 statt 0,2
  Cent je Folge).
- **MAI-Transcribe 2 wurde getestet und verworfen:** Seine Zeitachse war um
  die Länge des Werbeblocks verschoben, der vordere Block fehlte ganz. Daraus
  entstand die Sicherung `expectOpeningAd`: Fehlt der Werbeblock am Anfang,
  wird die ganze Analyse verworfen und es gelten die festen Werte. Lieber
  keine Automatik als eine, die Werbung durchlässt.
- **Modellnamen nie fest verdrahten:** Ein nicht mehr existierender Slug
  liess die Analyse still auf das schlechtere Modell zurückfallen. Jetzt
  wird die Modell-Liste abgefragt - inklusive
  `?output_modalities=transcription`, denn dort stehen die
  Transkriptionsmodelle, nicht im Standardkatalog.

Zwei Dinge haben sich dabei als entscheidend erwiesen:

- **Feine Zeilen.** Whisper liefert Abschnitte von 15-20 Sekunden; darauf lässt
  sich eine Werbegrenze nur grob legen. Deshalb werden zusätzlich Wort-Zeiten
  angefordert und daraus Zeilen von höchstens 8 Sekunden gebaut
  (`buildLinesFromWords`).
- **Aufbau der Sendung im Prompt.** Jeder Podcast in `AD_DETECT_PODCASTS` kann
  ein Feld `structure` mitbringen, das den Aufbau in Worten beschreibt (beim
  Handelsblatt: Themenvorstellung, Werbung, Themen, Werbung am Schluss). Ohne
  diesen Hinweis hat das Modell den Sponsorenblock gar nicht als Werbung
  erkannt. Wenn die Erkennung danebenliegt, ist das der erste Hebel.

Das läuft am Ende von `refreshDlfAudioCache()` mit - **kein zusätzlicher
Zeit-Trigger nötig**. Mit `testAdDetection()` lässt sich der Lauf von Hand
anstossen; das Protokoll zeigt Werbeblöcke, Themen, Modell und Laufzeit.

### Was das Frontend daraus macht

- **Werbung wird übersprungen**, egal wo sie liegt: Landet die Wiedergabe in
  einem `adRange`, springt der Player ans Ende dieses Blocks. Liegt danach nur
  noch Werbung, gilt die Folge als zu Ende (wie am Dateiende).
- **Alle Zeiten rechnen in "Hörzeit ohne Werbung"**: Fortschrittsbalken,
  verstrichene Zeit, Restzeit, die Sprungknöpfe (`+30s` springt 30 Sekunden
  *Inhalt* weiter, nicht in einen Werbeblock) und die Meldung ans Betriebssystem.
  Dafür sorgen `realToPlayable()` / `playableToReal()` in `index.html`.
- **Themen**: Über dem Fortschrittsbalken steht die Liste aller Themen mit
  ihrer Zeit, das laufende hervorgehoben; drei Zeilen sind sichtbar, der Rest
  scrollt, und die Liste läuft mit. Ein Tipp auf eine Zeile springt dorthin,
  daneben springt `Thema ⏭` zum nächsten. In der Sammlung stehen dort die
  Beiträge der Tagesliste. Gibt es keine Themen, verschwindet die Liste ganz.
- **Start / Ende aus der Tabelle gelten immer**, auch für eine analysierte
  Folge und die geschnittene Datei. Dort werden sie um die vorher
  herausgeschnittene Werbung umgerechnet.
- **Längenprüfung**: Die Marken gelten nur für die Fassung, die analysiert
  wurde. Bei Podcasts mit *Werbung schneiden* fallen sie ab 5 Sekunden
  Abweichung weg (der Anbieter baut Werbung dynamisch ein). Bei allen anderen
  erst ab 15 Sekunden bzw. 5 %: Die Datei ändert sich dort nicht, und das
  Handy schätzt die Länge einer MP3 oft ein paar Sekunden anders als die
  Analyse. Daran fielen am 6.11. die Sprungmarken von HeuteMorgen weg.
- **Ohne Analyse** (ältere Folgen, anderer Podcast, Backend noch nicht
  aktualisiert) greifen die festen Werte aus `PODCAST_TRIM` - sie werden intern
  in genau dieselben Werbebereiche umgerechnet.

### Der Wecker: Google stösst die Analyse an

GitHub startet geplante Läufe nur "nach Möglichkeit". Für dieses Repository
kamen sie Stunden zu spät oder gar nicht: Am 4.11. ist zwischen 23:30 und
9:00 keiner der 15 geplanten Morgenläufe gestartet. Dann fehlen Schnitt und
Sprungmarken, und die App fällt auf ihre grobe Notlösung zurück (fester
Bereich 0:38-1:43 beim Handelsblatt, kein Schnitt am Ende).

Ein von aussen angestossener Lauf (`workflow_dispatch`) startet dagegen
sofort. `Wecker.gs` lässt deshalb Google-Zeitauslöser um 6:20, 7:00 und
19:00 die Analyse anstossen. Die geplanten Läufe in `analyze.yml` bleiben
als zusätzliches Netz.

**Der Morgenlauf wartet auf die Folge.** Die Uhrzeit im Feed sagt nicht,
wann die Folge wirklich dort steht: HeuteMorgen trägt 6:00, war am 5.11.
aber um 7:04 noch nicht im Feed. Läufe um 6:20 und 7:00 gingen ins Leere,
und weil die geplanten Morgenläufe wieder ausfielen, kamen Sprungmarken
erst um 13:13. Deshalb bleibt ein Lauf am Morgen (Montag bis Freitag)
stehen und schaut alle vier Minuten in die Feeds, bis jede Morgensendung
ihre Folge des Tages hat, längstens bis 10:00 (`tools/warten.mjs`).
Morgensendung heisst: Die zuletzt analysierte Folge ist zwischen 4 und 10
Uhr datiert. Nach jedem Durchgang wird gespeichert, eine fertige Folge ist
also sofort in der App. Ein Durchgang ohne neue Folge ist nur ein
Feed-Abruf und kostet nichts; eine Folge, deren Analyse zweimal scheitert,
wird im selben Lauf nicht noch einmal bezahlt.

Die App lädt die Analyse neu, wenn man nach mehr als fünf Minuten in sie
zurückkehrt. So kommen Schnitt und Sprungmarken auch an, wenn die App
schon vor der Analyse offen war.

Einrichten, einmalig:

1. Auf GitHub einen Token anlegen: Settings → Developer settings →
   Fine-grained tokens → nur Repository `obitusde/podcasts`, Berechtigung
   *Actions: Read and write*, sonst nichts.
2. Im Apps-Script-Projekt neben `Code.gs` eine neue Datei *Wecker*
   anlegen und den Inhalt von `Wecker.gs` hineinkopieren.
3. Projekteinstellungen → Script Properties → `GITHUB_TOKEN` mit dem Token.
4. Oben die Funktion `weckerEinrichten` wählen und einmal ausführen. Sie
   legt die Zeitauslöser an und stösst zur Probe einen Lauf an. Neu
   bereitstellen ist nicht nötig.

### Einmalige Schritte im Apps Script

1. Script Properties prüfen: `OPENROUTER_API_KEY` muss gesetzt sein (wird schon
   für die DLF-Dubletten benutzt).
2. Inhalt von `Code.gs` aus diesem Repo in den Apps-Script-Editor kopieren.
3. Bereitstellen → Bereitstellungen verwalten → vorhandene Bereitstellung
   bearbeiten → Version "Neu" → Bereitstellen (so bleibt die `/exec`-URL gleich).
4. Einmal `testAdDetection()` ausführen und das Protokoll ansehen.

## Bekannte Einschränkungen

- Manche Podcast-Anbieter (z. B. ARD Audiothek) haben keinen klassischen öffentlichen
  RSS-Feed mehr – dort hilft nur Suchen nach einem alternativen Feed (z. B. direkt bei
  Deutschlandfunk/Deutschlandradio, die eigene `.xml`-Feeds neben der ARD-Audiothek-
  Einbindung weiterführen).
- Der Apps-Script-Proxy cached Ergebnisse serverseitig für 10 Minuten
  (`CACHE_SECONDS` in `Code.gs`), neue Folgen erscheinen also mit etwas Verzögerung.
- `minDurationSeconds` filtert rein nach Länge, nicht nach Uhrzeit – falls ein Feed
  keine sauber unterscheidbaren Längen hat, taugt der Filter nicht.
