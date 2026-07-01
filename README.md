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

- Buttons in einer Zeile: `-10s`, `-5s`, `+5s`, `+10s`, `+30s`.
- Native Wiedergabeleiste (Play/Pause, Scrubber) kommt vom Browser (`<audio controls>`).
- **Media Session API**: externe Bedienung über Sperrbildschirm, Kopfhörer oder
  Auto-Bedienelemente funktioniert:
  - Play/Pause steuern die Wiedergabe direkt.
  - "Zurückspulen"/"Vorspulen" (z. B. auf dem Sperrbildschirm) sind fest auf **-5s /
    +10s** gelegt.
  - "Vorheriger/Nächster Titel" (z. B. Lenkradtasten) springt zur nächstälteren bzw.
    nächstneueren geladenen Folge und spielt sie sofort ab.
- **Wake Lock**: Der Bildschirm schläft nicht ein, solange die Seite sichtbar ist.
- Als installierte PWA sollte die Wiedergabe auch bei ausgeschaltetem Bildschirm
  weiterlaufen (abhängig vom Verhalten von Chrome/Android).

## Bekannte Einschränkungen

- Manche Podcast-Anbieter (z. B. ARD Audiothek) haben keinen klassischen öffentlichen
  RSS-Feed mehr – dort hilft nur Suchen nach einem alternativen Feed (z. B. direkt bei
  Deutschlandfunk/Deutschlandradio, die eigene `.xml`-Feeds neben der ARD-Audiothek-
  Einbindung weiterführen).
- Der Apps-Script-Proxy cached Ergebnisse serverseitig für 10 Minuten
  (`CACHE_SECONDS` in `Code.gs`), neue Folgen erscheinen also mit etwas Verzögerung.
- `minDurationSeconds` filtert rein nach Länge, nicht nach Uhrzeit – falls ein Feed
  keine sauber unterscheidbaren Längen hat, taugt der Filter nicht.
