/**
 * Podcast RSS Proxy
 * ------------------
 * Liefert zu einer beliebigen Podcast-Feed-URL die neueste Episode als JSON.
 * Wird gebraucht, weil die meisten Podcast-Feeds (z.B. srf.ch) keine
 * CORS-Header setzen und daher nicht direkt per fetch() vom Browser aus
 * (GitHub Pages) gelesen werden können.
 *
 * Aufruf:  DEIN_WEBAPP_URL?feed=https://www.srf.ch/feed/podcast/sd/....xml
 *
 * Deployment:
 *   Bereitstellen > Neue Bereitstellung > Typ: Web-App
 *     Ausführen als:  Ich
 *     Zugriff:        Jeder
 *   Die dabei erzeugte /exec-URL im Frontend (index.html) bei PROXY_URL eintragen.
 */

// Cache-Dauer in Sekunden, wie lange ein Feed-Ergebnis zwischengespeichert wird
var CACHE_SECONDS = 600; // 10 Minuten
var MAX_EPISODES = 15;   // wie viele Episoden pro Podcast zum Zurückblättern geladen werden

// --- DLF Audiobeiträge (produktiv) ---
var DLF_AUDIO_FEEDS = [
  { name: 'Informationen am Morgen', url: 'https://www.deutschlandfunk.de/informationen-am-morgen-102.xml' },
  { name: 'Informationen am Mittag', url: 'https://www.deutschlandfunk.de/informationen-am-mittag-102.xml' },
  { name: 'Informationen am Abend', url: 'https://www.deutschlandfunk.de/informationen-am-abend-110.xml' },
  { name: 'Wirtschaft und Gesellschaft', url: 'https://www.deutschlandfunk.de/wirtschaft-und-gesellschaft-104.xml' }
];
var DLF_AUDIO_HOURS_BACK = 20;       // Rückblick pro Trigger-Lauf (Trigger laufen 2x/Tag, ~18h Abstand -> Sicherheitsmarge)
var DLF_AUDIO_MAX_DURATION_SECONDS = 300; // alles über 5 Min. wird verworfen
var DLF_AUDIO_MODEL = 'google/gemini-3.1-flash-lite';
var DLF_AUDIO_PROP_KEY = 'dlfAudioEpisodes_v1';

// --- Titel-Bereinigung "Kommentare und Themen der Woche" ---
// Dieser Feed stellt jedem Titel "Kommentar - " oder "Kommentar zum/zur X: "
// voran, was im schmalen Karten-Layout nur Platz frisst (der Podcast-Name
// steht ja schon über dem Titel). Wird NUR für diesen einen Feed angewendet
// (per URL-Erkennung), nicht generell.
var KOMMENTAR_FEED_URL_MARKER = 'kommentar-100.xml';

function cleanKommentarTitle(title) {
  if (!title) return title;
  var cleaned = title.replace(/^Kommentar\s*[-:]?\s*(?:(?:zu der|zu die|zu den|zum|zur|zu)\s+)?/i, '');
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};

  if (params.mode === 'dlftest') {
    return handleDlfTest(params);
  }

  if (params.mode === 'dlfaudio') {
    return handleDlfAudioForFrontend();
  }

  var feedUrl = params.feed;
  if (!feedUrl) {
    return jsonResponse({ error: 'Parameter "feed" fehlt' });
  }

  var isKommentarFeed = feedUrl.indexOf(KOMMENTAR_FEED_URL_MARKER) !== -1;

  // Optional: nur Episoden ab dieser Mindestlänge (in Sekunden) übernehmen.
  // Nützlich für Feeds, die kurze und lange Ausgaben mischen (z.B. Nachrichten).
  var minDuration = params.minDuration ? parseInt(params.minDuration, 10) : 0;

  // Optional: nur Episoden, deren Titel diesen Text enthält (Gross-/Klein-
  // schreibung egal). Nützlich für Sammel-Feeds mit mehreren Künstlern/Autoren
  // im Titel (z.B. "Dieter Nuhr: ..." aus dem WDR-2-Kabarett-Feed).
  var titleContains = params.titleContains ? params.titleContains.toLowerCase() : '';

  var cache = CacheService.getScriptCache();
  var cacheKey = 'feed_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, feedUrl + '|' + minDuration + '|' + titleContains)
  );
  var cached = cache.get(cacheKey);
  if (cached) {
    return jsonResponse(JSON.parse(cached), true);
  }

  try {
    var response = UrlFetchApp.fetch(feedUrl, {
      muteHttpExceptions: true,
      followRedirects: true
    });

    if (response.getResponseCode() >= 400) {
      return jsonResponse({ error: 'Feed antwortet mit HTTP ' + response.getResponseCode() });
    }

    var xml = response.getContentText();
    var doc = XmlService.parse(xml);
    var root = doc.getRootElement();
    var channel = root.getChild('channel');

    if (!channel) {
      return jsonResponse({ error: 'Kein <channel> im Feed gefunden' });
    }

    var itunesNs = XmlService.getNamespace('itunes', 'http://www.itunes.com/dtds/podcast-1.0.dtd');

    var channelTitle = getText(channel, 'title');
    var channelImage = getChannelImage(channel, itunesNs);

    var items = channel.getChildren('item');
    if (items.length === 0) {
      return jsonResponse({ error: 'Keine Episoden im Feed gefunden' });
    }

    // Wenn nach Mindestdauer oder Titel gefiltert wird, weiter in den Feed
    // hineinschauen, damit trotz übersprungener Episoden genug zusammenkommen.
    // titleContains braucht mehr Tiefe als minDuration, weil bei einem
    // Sammel-Feed mit mehreren Künstlern oft nur jede 6.-8. Episode passt.
    var scanMultiplier = 1;
    if (minDuration > 0) scanMultiplier = Math.max(scanMultiplier, 8);
    if (titleContains) scanMultiplier = Math.max(scanMultiplier, 15);
    var scanLimit = Math.min(items.length, MAX_EPISODES * scanMultiplier);
    var episodes = [];

    for (var i = 0; i < scanLimit && episodes.length < MAX_EPISODES; i++) {
      var item = items[i];
      var enclosure = item.getChild('enclosure');
      var audioUrl = enclosure && enclosure.getAttribute('url') ? enclosure.getAttribute('url').getValue() : null;
      if (!audioUrl) continue; // Episoden ohne Audio (z.B. Trailer) überspringen

      var rawTitle = getText(item, 'title');
      if (titleContains && (!rawTitle || rawTitle.toLowerCase().indexOf(titleContains) === -1)) {
        continue; // Titel passt nicht zum Filter
      }

      var durationText = getItunesText(item, itunesNs, 'duration');
      var durationSeconds = parseDurationToSeconds(durationText);

      if (minDuration > 0 && (durationSeconds === null || durationSeconds < minDuration)) {
        continue; // zu kurz -> überspringen
      }

      var guidEl = item.getChild('guid');
      var guid = guidEl ? guidEl.getText() : audioUrl;

      episodes.push({
        guid: guid,
        title: isKommentarFeed ? cleanKommentarTitle(rawTitle) : rawTitle,
        pubDate: getText(item, 'pubDate'),
        audioUrl: audioUrl,
        imageUrl: getItemImage(item, itunesNs) || channelImage,
        duration: durationText || null,
        description: cleanDescription(getText(item, 'description'))
      });
    }

    if (episodes.length === 0) {
      return jsonResponse({ error: 'Keine Episode mit Audio-Datei gefunden' });
    }

    var result = {
      podcastTitle: channelTitle,
      episodes: episodes
    };

    cache.put(cacheKey, JSON.stringify(result), CACHE_SECONDS);
    return jsonResponse(result, false);
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}

function getText(parent, childName) {
  var child = parent.getChild(childName);
  return child ? child.getText() : null;
}

function cleanDescription(text) {
  if (!text) return null;
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function getItunesText(parent, ns, childName) {
  var child = parent.getChild(childName, ns);
  return child ? child.getText() : null;
}

function parseDurationToSeconds(durationText) {
  if (!durationText) return null;
  var parts = durationText.trim().split(':');
  if (parts.some(function(p) { return isNaN(parseInt(p, 10)); })) return null;

  if (parts.length === 1) {
    return parseInt(parts[0], 10);
  } else if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  } else if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  }
  return null;
}

function getChannelImage(channel, itunesNs) {
  var itunesImage = channel.getChild('image', itunesNs);
  if (itunesImage) {
    var href = itunesImage.getAttribute('href');
    if (href) return href.getValue();
  }
  var image = channel.getChild('image');
  if (image) {
    var url = image.getChild('url');
    if (url) return url.getText();
  }
  return null;
}

function getItemImage(item, itunesNs) {
  var itunesImage = item.getChild('image', itunesNs);
  if (itunesImage) {
    var href = itunesImage.getAttribute('href');
    if (href) return href.getValue();
  }
  return null;
}

function jsonResponse(obj, fromCache) {
  obj._cached = !!fromCache;
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * DIAGNOSE-FEATURE (temporär, nicht produktiv): DLF-Kurzbeiträge testen
 * ------------------------------------------------------------------------
 * Idee: statt der langen "Informationen am Morgen/Mittag/Abend"-Sendungen
 * gibt es evtl. einen Feed mit den einzelnen kurzen Beiträgen daraus
 * (im Podcast-Verzeichnis als "Deutschlandfunk aktuell" gelistet, Ø 6 Min./
 * Folge). Die genaue Feed-URL ist nicht 100% sicher, deshalb werden hier
 * mehrere Kandidaten-URLs LIVE getestet:
 *   1. der vermutete "Deutschlandfunk aktuell"-Feed (an Informationen am
 *      Morgen gehängt: .../podcast-informationen-am-morgen.782.de.podcast.xml)
 *   2-4. die drei Sendungsseiten-URLs 1:1 als .xml (könnten die ganze
 *      Sendung liefern statt Einzelbeiträge, oder gar nicht existieren -
 *      genau das soll dieser Test zeigen)
 *
 * Aufruf:  DEIN_WEBAPP_URL?mode=dlftest
 *   optionale Parameter:
 *     hours=<Zahl>          (Default: 24) - nur Beiträge der letzten X Stunden
 *     simThreshold=<0..1>   (Default: 0.4) - wie ähnlich sich zwei Titel sein
 *                            müssen (Wort-Überlappung), um als mögliches
 *                            Duplikat-Paar zu gelten
 *
 * Gibt eine lesbare HTML-Seite zurück (kein JSON) - einfach die WebApp-URL
 * mit ?mode=dlftest im Browser öffnen.
 */
function handleDlfTest(params) {
  var hoursBack = params.hours ? parseFloat(params.hours) : 24;
  var simThreshold = params.simThreshold ? parseFloat(params.simThreshold) : 0.4;

  var candidates = [
    {
      label: 'Informationen am Morgen (Einzelbeiträge, bestätigt)',
      url: 'https://www.deutschlandfunk.de/informationen-am-morgen-102.xml'
    },
    {
      label: 'Informationen am Abend (Einzelbeiträge, korrigierte URL)',
      url: 'https://www.deutschlandfunk.de/informationen-am-abend-110.xml'
    },
    {
      label: 'Informationen am Mittag (Einzelbeiträge, korrigierte URL)',
      url: 'https://www.deutschlandfunk.de/informationen-am-mittag-102.xml'
    },
    {
      label: 'Wirtschaft und Gesellschaft (neu, noch nicht live gesehen)',
      url: 'https://www.deutschlandfunk.de/wirtschaft-und-gesellschaft-104.xml'
    }
  ];

  var feedResults = [];
  var allItems = []; // Pool für die Duplikat-Analyse über alle Feeds hinweg

  candidates.forEach(function(c) {
    var feedResult = {
      label: c.label,
      url: c.url,
      status: null,
      error: null,
      itemCountTotal: 0,
      episodes: []
    };

    try {
      var resp = UrlFetchApp.fetch(c.url, { muteHttpExceptions: true, followRedirects: true });
      feedResult.status = resp.getResponseCode();

      if (feedResult.status >= 400) {
        feedResult.error = 'HTTP ' + feedResult.status;
      } else {
        var xml = resp.getContentText();
        var doc = XmlService.parse(xml);
        var channel = doc.getRootElement().getChild('channel');

        if (!channel) {
          feedResult.error = 'Kein <channel> im XML gefunden (evtl. keine gültige RSS-Antwort)';
        } else {
          var itunesNs = XmlService.getNamespace('itunes', 'http://www.itunes.com/dtds/podcast-1.0.dtd');
          var items = channel.getChildren('item');
          feedResult.itemCountTotal = items.length;

          var cutoff = new Date(Date.now() - hoursBack * 3600 * 1000);
          var scanLimit = Math.min(items.length, 400);

          for (var i = 0; i < scanLimit; i++) {
            var item = items[i];
            var pubDateText = getText(item, 'pubDate');
            var pubDate = pubDateText ? new Date(pubDateText) : null;
            if (pubDate && pubDate < cutoff) continue;

            var durationText = getItunesText(item, itunesNs, 'duration');
            var durationSeconds = parseDurationToSeconds(durationText);
            var title = getText(item, 'title');

            var ep = {
              title: title,
              pubDate: pubDateText,
              durationSeconds: durationSeconds,
              source: c.label
            };
            feedResult.episodes.push(ep);
            allItems.push(ep);
          }
        }
      }
    } catch (err) {
      feedResult.error = err.toString();
    }

    feedResults.push(feedResult);
  });

  var dupGroups = findDuplicateGroups(allItems, simThreshold);

  return htmlDiagResponse(feedResults, dupGroups, hoursBack, simThreshold);
}

// Normalisiert einen Titel (Kleinschreibung, Satzzeichen raus) und liefert
// ein Set der "bedeutungstragenden" Wörter (>3 Zeichen, ohne Stopwörter).
var DLF_STOPWORDS = ['und', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen',
  'einem', 'einer', 'in', 'im', 'für', 'mit', 'auf', 'zu', 'von', 'nach', 'ist', 'sich', 'auch',
  'wird', 'wurde', 'werden', 'bei', 'über', 'als', 'so', 'noch', 'nicht', 'sind', 'war', 'waren',
  'vor', 'um', 'an', 'aus', 'durch', 'wegen', 'soll', 'sollen', 'können', 'kann', 'mehr'];

function titleWordSet(title) {
  if (!title) return {};
  var norm = title.toLowerCase()
    .replace(/[„“"'’`.,:;!?()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  var words = norm.split(' ').filter(function(w) {
    return w.length > 3 && DLF_STOPWORDS.indexOf(w) === -1;
  });
  var set = {};
  words.forEach(function(w) { set[w] = true; });
  return set;
}

function jaccardSimilarity(setA, setB) {
  var keysA = Object.keys(setA);
  var keysB = Object.keys(setB);
  if (keysA.length === 0 || keysB.length === 0) return 0;
  var intersection = 0;
  keysA.forEach(function(k) { if (setB[k]) intersection++; });
  var union = keysA.length + keysB.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Gruppiert Beiträge über alle Feeds hinweg nach Titel-Ähnlichkeit
// (Union-Find). Gibt nur Gruppen mit 2+ Beiträgen zurück, sortiert nach
// Dauer aufsteigend (kürzester zuerst = die Empfehlung "behalten").
function findDuplicateGroups(items, threshold) {
  var n = items.length;
  var parent = [];
  for (var i = 0; i < n; i++) parent.push(i);

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    var ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  var wordSets = items.map(function(it) { return titleWordSet(it.title); });

  for (var i = 0; i < n; i++) {
    for (var j = i + 1; j < n; j++) {
      if (jaccardSimilarity(wordSets[i], wordSets[j]) >= threshold) union(i, j);
    }
  }

  var groupsMap = {};
  for (var i = 0; i < n; i++) {
    var root = find(i);
    if (!groupsMap[root]) groupsMap[root] = [];
    groupsMap[root].push(items[i]);
  }

  var groups = [];
  Object.keys(groupsMap).forEach(function(key) {
    if (groupsMap[key].length > 1) {
      groups.push(groupsMap[key].slice().sort(function(a, b) {
        var da = a.durationSeconds || Infinity;
        var db = b.durationSeconds || Infinity;
        return da - db;
      }));
    }
  });

  return groups;
}

function htmlDiagResponse(feedResults, dupGroups, hoursBack, simThreshold) {
  var html = '<html><head><meta charset="utf-8"><title>DLF Diagnose</title>';
  html += '<style>body{font-family:sans-serif;font-size:14px;margin:20px;color:#222;}' +
    'table{border-collapse:collapse;width:100%;margin-bottom:24px;}' +
    'td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top;}' +
    'th{background:#eee;} .err{color:#b00;font-weight:bold;} .dup{background:#fff3cd;}' +
    'h2{margin-top:32px;} code{background:#f4f4f4;padding:2px 4px;}</style></head><body>';

  html += '<h1>DLF Feed-Diagnose</h1>';
  html += '<p>Zeitfenster: letzte ' + hoursBack + ' Std. &nbsp;|&nbsp; Duplikat-Schwelle (Wort-Überlappung): ' + simThreshold + '</p>';

  feedResults.forEach(function(f) {
    html += '<h2>' + escapeHtml(f.label) + '</h2>';
    html += '<p><code>' + escapeHtml(f.url) + '</code><br>';
    html += 'Status: ' + f.status + (f.error ? ' — <span class="err">' + escapeHtml(f.error) + '</span>' : '') + '<br>';
    html += 'Items im Feed insgesamt: ' + f.itemCountTotal + ' &nbsp;|&nbsp; davon im Zeitfenster: ' + f.episodes.length + '</p>';

    if (f.episodes.length > 0) {
      html += '<table><tr><th>Titel</th><th>Datum</th><th>Dauer</th></tr>';
      f.episodes.forEach(function(ep) {
        var mins = ep.durationSeconds ? Math.round(ep.durationSeconds / 60) + ' Min.' : '?';
        html += '<tr><td>' + escapeHtml(ep.title || '') + '</td><td>' + escapeHtml(ep.pubDate || '') + '</td><td>' + mins + '</td></tr>';
      });
      html += '</table>';
    }
  });

  html += '<h2>Mögliche Duplikate (Themen-Ähnlichkeit über alle Feeds hinweg)</h2>';
  if (dupGroups.length === 0) {
    html += '<p>Keine Duplikat-Kandidaten gefunden.</p>';
  } else {
    dupGroups.forEach(function(group, idx) {
      html += '<table class="dup"><tr><th colspan="4">Gruppe ' + (idx + 1) + '</th></tr>';
      html += '<tr><th>Titel</th><th>Quelle</th><th>Dauer</th><th>Empfehlung</th></tr>';
      group.forEach(function(ep, i) {
        var mins = ep.durationSeconds ? Math.round(ep.durationSeconds / 60) + ' Min.' : '?';
        html += '<tr><td>' + escapeHtml(ep.title || '') + '</td><td>' + escapeHtml(ep.source || '') + '</td><td>' + mins + '</td><td>' + (i === 0 ? 'behalten (kürzeste)' : 'verwerfen') + '</td></tr>';
      });
      html += '</table>';
    });
  }

  html += '</body></html>';
  return HtmlService.createHtmlOutput(html);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * PRODUKTIV-FEATURE: DLF Audiobeiträge
 * ------------------------------------------------------------------------
 * Sammelt Kurzbeiträge (<=5 Min.) aus 4 DLF-Sendungen der letzten
 * DLF_AUDIO_HOURS_BACK Stunden, lässt inhaltliche Duplikate (dieselbe
 * Meldung zu verschiedenen Tageszeiten) per LLM (OpenRouter) gruppieren
 * und behält pro Gruppe nur den kürzesten Beitrag. Das Ergebnis wird in
 * PropertiesService gespeichert (nicht CacheService - das hält nur max.
 * 6h, wir brauchen es aber über den vollen Abstand zwischen den beiden
 * täglichen Trigger-Läufen hinweg verfügbar).
 *
 * WICHTIG: diese Funktion NICHT bei jedem Seitenaufruf laufen lassen,
 * sondern nur per Zeit-Trigger, 2x/Tag:
 *   Apps Script Editor > Uhr-Symbol "Trigger" > Trigger hinzufügen
 *     Funktion: refreshDlfAudioCache
 *     Ereignisquelle: Zeitgesteuert > Tages-Timer > 6 - 7 Uhr
 *   und ein zweites Mal:
 *     Funktion: refreshDlfAudioCache
 *     Ereignisquelle: Zeitgesteuert > Tages-Timer > 12 - 13 Uhr
 *
 * Ist noch kein Ergebnis gespeichert (z.B. direkt nach dem Deployment,
 * bevor der erste Trigger gelaufen ist), liefert das Frontend eine leere
 * Liste zurück statt live nachzuladen - damit nie ungeplant ein
 * LLM-Call durch einen simplen Seitenaufruf ausgelöst wird.
 */
function refreshDlfAudioCache() {
  var cutoff = new Date(Date.now() - DLF_AUDIO_HOURS_BACK * 3600 * 1000);
  var pool = [];

  DLF_AUDIO_FEEDS.forEach(function(feed) {
    try {
      var resp = UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true, followRedirects: true });
      if (resp.getResponseCode() >= 400) return; // ein Feed down -> Rest trotzdem weitermachen

      var doc = XmlService.parse(resp.getContentText());
      var channel = doc.getRootElement().getChild('channel');
      if (!channel) return;

      var itunesNs = XmlService.getNamespace('itunes', 'http://www.itunes.com/dtds/podcast-1.0.dtd');
      var channelImage = getChannelImage(channel, itunesNs);
      var items = channel.getChildren('item');
      var scanLimit = Math.min(items.length, 200);

      for (var i = 0; i < scanLimit; i++) {
        var item = items[i];
        var pubDateText = getText(item, 'pubDate');
        var pubDate = pubDateText ? new Date(pubDateText) : null;
        if (pubDate && pubDate < cutoff) continue;

        var durationText = getItunesText(item, itunesNs, 'duration');
        var durationSeconds = parseDurationToSeconds(durationText);
        // Alles über 5 Min. raus (deckt u.a. "komplette Sendung"-Einträge
        // bei Informationen am Abend sowie lange Interviews ab). Fehlende
        // Dauer wird NICHT verworfen - besser ein Beitrag zu viel drin als
        // fälschlich einen kurzen zu verlieren, nur weil das Tag fehlt.
        if (durationSeconds !== null && durationSeconds > DLF_AUDIO_MAX_DURATION_SECONDS) continue;

        var enclosure = item.getChild('enclosure');
        var audioUrl = enclosure && enclosure.getAttribute('url') ? enclosure.getAttribute('url').getValue() : null;
        if (!audioUrl) continue;

        var guidEl = item.getChild('guid');
        var guid = guidEl ? guidEl.getText() : audioUrl;

        pool.push({
          guid: guid,
          title: getText(item, 'title'),
          pubDate: pubDateText,
          pubDateMs: pubDate ? pubDate.getTime() : 0,
          audioUrl: audioUrl,
          imageUrl: getItemImage(item, itunesNs) || channelImage,
          durationSeconds: durationSeconds,
          source: feed.name
        });
      }
    } catch (err) {
      // einzelnen Feed überspringen, Rest weiterlaufen lassen
    }
  });

  if (pool.length === 0) {
    saveDlfAudioResult({ podcastTitle: 'DLF Audiobeiträge', episodes: [], lastUpdated: new Date().toISOString() });
    return;
  }

  var dupGroups = [];
  try {
    dupGroups = callOpenRouterDedup(pool);
  } catch (err) {
    dupGroups = []; // Dedup fehlgeschlagen -> lieber ohne Dedup weitermachen als ganz zu scheitern
  }

  var dropIndex = {};
  dupGroups.forEach(function(group) {
    if (!group || group.length < 2) return;
    var validIdx = group.filter(function(idx) { return pool[idx]; });
    if (validIdx.length < 2) return;
    validIdx.sort(function(a, b) {
      var da = pool[a].durationSeconds === null ? Infinity : pool[a].durationSeconds;
      var db = pool[b].durationSeconds === null ? Infinity : pool[b].durationSeconds;
      return da - db;
    });
    for (var k = 1; k < validIdx.length; k++) {
      dropIndex[validIdx[k]] = true;
    }
  });

  var episodes = pool
    .filter(function(_, idx) { return !dropIndex[idx]; })
    .sort(function(a, b) { return b.pubDateMs - a.pubDateMs; })
    .map(function(ep) {
      return {
        guid: ep.guid,
        title: ep.title,
        pubDate: ep.pubDate,
        audioUrl: ep.audioUrl,
        imageUrl: ep.imageUrl,
        duration: ep.durationSeconds !== null ? String(ep.durationSeconds) : null,
        description: null
      };
    });

  saveDlfAudioResult({ podcastTitle: 'DLF Audiobeiträge', episodes: episodes, lastUpdated: new Date().toISOString() });
}

// Fragt OpenRouter, welche Beiträge im Pool dasselbe Thema behandeln.
// Gibt eine Liste von Gruppen (Arrays von Pool-Indizes) zurück; nur echte
// Duplikat-Gruppen (2+ Einträge), Einzelbeiträge werden nicht gelistet.
function callOpenRouterDedup(pool) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('OPENROUTER_API_KEY') || props.getProperty('OPENROUTER_KEY');
  if (!apiKey) throw new Error('Kein OpenRouter API-Key in den Script Properties gefunden (OPENROUTER_API_KEY oder OPENROUTER_KEY)');

  var itemList = pool.map(function(it, idx) {
    return {
      index: idx,
      title: it.title,
      sendung: it.source,
      minuten: it.durationSeconds !== null ? Math.round(it.durationSeconds / 60) : null
    };
  });

  var prompt = 'Du bekommst eine JSON-Liste kurzer Radio-Nachrichtenbeiträge des Deutschlandfunks ' +
    '(Felder: index, title, sendung, minuten).\n' +
    'Gruppiere die Beiträge, die über dasselbe Ereignis bzw. dieselbe Meldung berichten, auch wenn ' +
    'der Titel unterschiedlich formuliert ist (z.B. dieselbe Meldung morgens und mittags erneut vorgetragen).\n' +
    'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt exakt dieser Form, ohne Markdown-Codeblock und ohne ' +
    'jeglichen Text davor oder danach:\n' +
    '{"groups": [[3, 7], [1, 5, 9]]}\n' +
    'Jede innere Liste enthält die "index"-Werte einer Gruppe von mindestens 2 Beiträgen zum selben Thema. ' +
    'Beiträge ohne Duplikat NICHT auflisten.\n\n' +
    'Beiträge:\n' + JSON.stringify(itemList);

  var payload = {
    model: DLF_AUDIO_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0
  };

  var resp = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() >= 400) {
    throw new Error('OpenRouter HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText());
  }

  var data = JSON.parse(resp.getContentText());
  var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('Keine Antwort von OpenRouter erhalten');

  var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  var parsed = JSON.parse(cleaned);
  return parsed.groups || [];
}

function handleDlfAudioForFrontend() {
  var stored = loadPropertyChunked(DLF_AUDIO_PROP_KEY);
  if (!stored) {
    // Noch kein Trigger-Lauf gab es bisher - bewusst KEIN Live-Scan hier,
    // damit nie ein Seitenaufruf ungeplant einen LLM-Call auslöst.
    return jsonResponse({
      podcastTitle: 'DLF Audiobeiträge',
      episodes: [],
      error: 'Noch keine Daten - der erste Trigger-Lauf (refreshDlfAudioCache) steht noch aus'
    });
  }
  return jsonResponse(JSON.parse(stored), true);
}

function saveDlfAudioResult(result) {
  savePropertyChunked(DLF_AUDIO_PROP_KEY, JSON.stringify(result));
}

// --- Chunked PropertiesService-Speicher ---
// PropertiesService erlaubt max. 9 KB pro Property. Damit die
// Episodenliste (Titel + Audio-/Bild-URLs) nicht an dieses Limit stösst,
// wird der JSON-String in mehrere kleinere Properties aufgeteilt und beim
// Lesen wieder zusammengesetzt.
var PROP_CHUNK_SIZE = 8000; // Sicherheitsabstand zum 9-KB-Limit

function savePropertyChunked(baseKey, str) {
  var props = PropertiesService.getScriptProperties();

  var oldCount = parseInt(props.getProperty(baseKey + '_count') || '0', 10);
  for (var i = 0; i < oldCount; i++) props.deleteProperty(baseKey + '_' + i);

  var chunks = [];
  for (var i = 0; i < str.length; i += PROP_CHUNK_SIZE) {
    chunks.push(str.substring(i, i + PROP_CHUNK_SIZE));
  }
  chunks.forEach(function(chunk, idx) {
    props.setProperty(baseKey + '_' + idx, chunk);
  });
  props.setProperty(baseKey + '_count', String(chunks.length));
}

function loadPropertyChunked(baseKey) {
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty(baseKey + '_count') || '0', 10);
  if (count === 0) return null;
  var parts = [];
  for (var i = 0; i < count; i++) {
    parts.push(props.getProperty(baseKey + '_' + i) || '');
  }
  return parts.join('');
}