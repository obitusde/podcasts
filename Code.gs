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

// SRF-Audiobeiträge: Sendungen, die NICHT in der Rubrik "SRF Audiobeiträge" erscheinen sollen
var BLOCKED_SHOWS = ['Regionaljournal Ostschweiz', 'Musikwelle aktuell', 'Bestseller auf dem Plattenteller'];
var DEFAULT_NEWS_FEED = 'https://www.srf.ch/news/bnf/rss/19032223'; // "Das Neueste"
var AUDIOSCAN_CACHE_KEY = 'srf_audioscan_episodes_v1';
var AUDIOSCAN_CACHE_SECONDS = 21600; // 6h Maximum von CacheService; wird per Trigger stündlich aufgefrischt

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};

  if (params.mode === 'audioscan') {
    return handleAudioScan(params);
  }

  if (params.mode === 'srfaudio') {
    return handleSrfAudioForFrontend();
  }

  var feedUrl = params.feed;
  if (!feedUrl) {
    return jsonResponse({ error: 'Parameter "feed" fehlt' });
  }

  // Optional: nur Episoden ab dieser Mindestlänge (in Sekunden) übernehmen.
  // Nützlich für Feeds, die kurze und lange Ausgaben mischen (z.B. Nachrichten).
  var minDuration = params.minDuration ? parseInt(params.minDuration, 10) : 0;

  var cache = CacheService.getScriptCache();
  var cacheKey = 'feed_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, feedUrl + '|' + minDuration)
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

    // Wenn nach Mindestdauer gefiltert wird, weiter in den Feed hineinschauen,
    // damit trotz übersprungener kurzer Episoden genug lange zusammenkommen.
    var scanLimit = minDuration > 0 ? Math.min(items.length, MAX_EPISODES * 8) : Math.min(items.length, MAX_EPISODES);
    var episodes = [];

    for (var i = 0; i < scanLimit && episodes.length < MAX_EPISODES; i++) {
      var item = items[i];
      var enclosure = item.getChild('enclosure');
      var audioUrl = enclosure && enclosure.getAttribute('url') ? enclosure.getAttribute('url').getValue() : null;
      if (!audioUrl) continue; // Episoden ohne Audio (z.B. Trailer) überspringen

      var durationText = getItunesText(item, itunesNs, 'duration');
      var durationSeconds = parseDurationToSeconds(durationText);

      if (minDuration > 0 && (durationSeconds === null || durationSeconds < minDuration)) {
        continue; // zu kurz -> überspringen
      }

      var guidEl = item.getChild('guid');
      var guid = guidEl ? guidEl.getText() : audioUrl;

      episodes.push({
        guid: guid,
        title: getText(item, 'title'),
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
 * TEST-FEATURE: SRF-News-Feed nach Artikeln mit Audio-Beitrag durchsuchen.
 * ------------------------------------------------------------------------
 * Idee: SRF-Artikelseiten enthalten (falls ein Radio-/Audio-Beitrag dabei
 * ist) ein verstecktes Attribut data-asset="{...urn:srf:audio:...}" im
 * rohen HTML. Diese URN wird dann über die öffentliche SRG-SSR
 * "Integration Layer"-API aufgelöst, um an die echte, abspielbare
 * MP3-URL zu kommen.
 *
 * Aufruf:
 *   DEIN_WEBAPP_URL?mode=audioscan
 *   optionale Parameter:
 *     newsFeed=<RSS-URL>      (Default: "Das Neueste")
 *     hours=<Zahl>            (Default: 24) - nur Artikel der letzten X Stunden
 *     maxArticles=<Zahl>      (Default: 20) - wie viele Artikel maximal geprüft werden
 *
 * Gibt zurück: Liste aller Artikel mit Audio, inkl. Titel, Sendung, Dauer,
 * Text-Teaser und der fertigen MP3-URL. Artikel ohne Audio werden nicht
 * einzeln aufgeführt, aber gezählt (skippedNoAudio).
 */
function handleAudioScan(params) {
  var newsFeedUrl = params.newsFeed || 'https://www.srf.ch/news/bnf/rss/19032223'; // "Das Neueste"
  var hoursBack = params.hours ? parseFloat(params.hours) : 24;
  var maxArticles = params.maxArticles ? parseInt(params.maxArticles, 10) : 20;

  var result = {
    newsFeed: newsFeedUrl,
    hoursBack: hoursBack,
    checkedArticles: 0,
    skippedTooOld: 0,
    skippedNoAudio: 0,
    errors: [],
    audioArticles: []
  };

  try {
    var feedXml = UrlFetchApp.fetch(newsFeedUrl, { muteHttpExceptions: true }).getContentText();
    var doc = XmlService.parse(feedXml);
    var channel = doc.getRootElement().getChild('channel');
    var items = channel.getChildren('item');

    var cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    for (var i = 0; i < items.length && result.checkedArticles < maxArticles; i++) {
      var item = items[i];
      var link = getText(item, 'link');
      var pubDateText = getText(item, 'pubDate');
      var pubDate = pubDateText ? new Date(pubDateText) : null;

      if (pubDate && pubDate < cutoff) {
        result.skippedTooOld++;
        continue;
      }
      if (!link) continue;

      result.checkedArticles++;

      try {
        var asset = fetchArticleAudioAsset(link);
        if (!asset) {
          result.skippedNoAudio++;
          continue;
        }

        var resolved = resolveAudioUrn(asset.urn);

        result.audioArticles.push({
          articleTitle: getText(item, 'title'),
          articleLink: link,
          pubDate: pubDateText,
          show: asset.show || null,
          audioTitle: asset.title || null,
          durationSeconds: asset.durationSeconds || null,
          audioUrl: resolved ? resolved.audioUrl : null,
          resolveError: resolved ? null : 'Konnte URN nicht auflösen'
        });
      } catch (articleErr) {
        result.errors.push({ link: link, error: articleErr.toString() });
      }
    }
  } catch (err) {
    result.fatalError = err.toString();
  }

  return jsonResponse(result);
}

// Holt die Artikel-HTML-Seite und extrahiert das erste data-asset mit
// type "audio" daraus (falls vorhanden).
function fetchArticleAudioAsset(articleUrl) {
  var html = UrlFetchApp.fetch(articleUrl, { muteHttpExceptions: true }).getContentText();

  var regex = /data-asset="([^"]*)"/g;
  var match;
  while ((match = regex.exec(html)) !== null) {
    var raw = unescapeHtmlEntities(match[1]);
    var asset;
    try {
      asset = JSON.parse(raw);
    } catch (e) {
      continue; // kein valides JSON -> überspringen
    }
    if (asset && asset.type === 'audio' && asset.urn) {
      return asset;
    }
  }
  return null;
}

// Löst eine urn:srf:audio:... über die öffentliche SRG-SSR Integration
// Layer API zur echten MP3-URL auf (inkl. Bild und Beschreibung, quasi
// "gratis" in derselben Antwort enthalten).
function resolveAudioUrn(urn) {
  var url = 'https://il.srgssr.ch/integrationlayer/2.0/mediaComposition/byUrn/' + urn + '.json';
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() >= 400) return null;

  var data = JSON.parse(response.getContentText());
  var chapter = data.chapterList && data.chapterList[0];
  var resource = chapter && chapter.resourceList && chapter.resourceList[0];
  if (!resource || !resource.url) return null;

  return {
    audioUrl: resource.url,
    imageUrl: (data.episode && data.episode.imageUrl) || null,
    lead: (data.episode && data.episode.lead) || null
  };
}

function unescapeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * PRODUKTIV-FEATURE: "SRF Audiobeiträge" fürs Frontend.
 * ------------------------------------------------------------------------
 * Liefert die Audio-Artikel im selben JSON-Format wie die normalen
 * Podcast-Feeds ({ podcastTitle, episodes: [...] }), damit das Frontend
 * (index.html) sie über dieselbe Karten-/Player-Logik behandeln kann wie
 * einen ganz normalen Podcast - nur dass die "Episoden" hier einzelne
 * SRF-News-Audiobeiträge sind statt Podcast-Folgen.
 *
 * Liest normalerweise aus dem Cache (sofort, kein Warten). Der Cache wird
 * durch einen zeitgesteuerten Trigger stündlich aufgefrischt (siehe
 * refreshAudioScanCache). Ist der Cache leer (z.B. ganz am Anfang, bevor
 * der Trigger das erste Mal gelaufen ist), wird einmalig ein kleinerer
 * Live-Scan gemacht, damit die Seite nicht leer bleibt.
 *
 * WICHTIG: Damit das im Alltag schnell bleibt, unbedingt einen Trigger
 * einrichten (Apps Script Editor > Uhr-Symbol "Trigger" > Trigger
 * hinzufügen > Funktion: refreshAudioScanCache > Zeitgesteuert > Stunden-
 * Timer > alle Stunde).
 */
function handleSrfAudioForFrontend() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(AUDIOSCAN_CACHE_KEY);
  if (cached) {
    return jsonResponse(JSON.parse(cached), true);
  }

  // Noch kein Cache vorhanden -> kleinerer Live-Scan als Notlösung
  var episodes = buildAudioEpisodes(DEFAULT_NEWS_FEED, 24, 25);
  var result = { podcastTitle: 'SRF Audiobeiträge', episodes: episodes };
  cache.put(AUDIOSCAN_CACHE_KEY, JSON.stringify(result), AUDIOSCAN_CACHE_SECONDS);
  return jsonResponse(result, false);
}

/**
 * Für den zeitgesteuerten Trigger: aktualisiert den Cache für
 * "SRF Audiobeiträge" im Hintergrund, damit Seitenaufrufe immer sofort
 * aus dem Cache bedient werden können.
 *
 * Einrichtung (einmalig): Apps Script Editor > linke Seitenleiste, Uhr-
 * Symbol "Trigger" > "+ Trigger hinzufügen" > Funktion "refreshAudioScanCache"
 * auswählen > Ereignisquelle "Zeitgesteuert" > Typ "Stunden-Timer" >
 * "Alle Stunde" > Speichern.
 */
function refreshAudioScanCache() {
  var episodes = buildAudioEpisodes(DEFAULT_NEWS_FEED, 24, 80);
  var result = { podcastTitle: 'SRF Audiobeiträge', episodes: episodes };
  CacheService.getScriptCache().put(AUDIOSCAN_CACHE_KEY, JSON.stringify(result), AUDIOSCAN_CACHE_SECONDS);
}

// Durchsucht den News-Feed und baut daraus eine "episodes"-Liste im
// selben Format wie die normalen Podcast-Feeds. Wendet dabei BLOCKED_SHOWS an.
function buildAudioEpisodes(newsFeedUrl, hoursBack, maxArticles) {
  var episodes = [];

  var feedXml = UrlFetchApp.fetch(newsFeedUrl, { muteHttpExceptions: true }).getContentText();
  var doc = XmlService.parse(feedXml);
  var channel = doc.getRootElement().getChild('channel');
  var items = channel.getChildren('item');

  var cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  var checked = 0;

  for (var i = 0; i < items.length && checked < maxArticles; i++) {
    var item = items[i];
    var link = getText(item, 'link');
    var pubDateText = getText(item, 'pubDate');
    var pubDate = pubDateText ? new Date(pubDateText) : null;

    if (pubDate && pubDate < cutoff) continue;
    if (!link) continue;
    checked++;

    try {
      var asset = fetchArticleAudioAsset(link);
      if (!asset) continue;
      if (isBlockedShow(asset.show)) continue;

      var resolved = resolveAudioUrn(asset.urn);
      if (!resolved || !resolved.audioUrl) continue;

      episodes.push({
        guid: asset.urn,
        title: getText(item, 'title'),
        pubDate: pubDateText,
        audioUrl: resolved.audioUrl,
        imageUrl: resolved.imageUrl,
        duration: asset.durationSeconds ? String(asset.durationSeconds) : null,
        description: resolved.lead || asset.lead || cleanDescription(getText(item, 'description'))
      });
    } catch (err) {
      continue; // einzelnen Artikel überspringen, Rest weiterlaufen lassen
    }
  }

  return episodes;
}

function isBlockedShow(show) {
  if (!show) return false;
  return BLOCKED_SHOWS.some(function(blocked) {
    return show.toLowerCase() === blocked.toLowerCase();
  });
}
