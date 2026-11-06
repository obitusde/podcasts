/**
 * Erkundung: Wie liefert tagesschau.de die Audiobeiträge seiner Artikel?
 *
 * Gedacht als Vorarbeit, um die Audiobeiträge eines Tages in die Sammlung
 * aufzunehmen. Gibt nur aus, was es findet; ändert nichts.
 *
 * Aufruf: node tools/tagesschau-audio.mjs [artikel-adresse]
 */
const artikel = process.argv[2] || 'https://www.tagesschau.de/wirtschaft/midterms-wirtschaft-handelspolitik-100.html';
const UA = { 'user-agent': 'Mozilla/5.0 (podcast-erkundung)' };

async function hole(url) {
  const res = await fetch(url, { redirect: 'follow', headers: UA });
  const text = await res.text();
  console.log(`\n### ${url}\n    HTTP ${res.status}, ${text.length} Zeichen, ${res.headers.get('content-type')}`);
  return text;
}

// Alle Stellen in einem JSON-Baum, deren Schlüssel oder Wert nach Audio aussieht.
function audioStellen(obj, pfad = '', aus = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => audioStellen(v, `${pfad}[${i}]`, aus));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = pfad ? `${pfad}.${k}` : k;
      if (/audio|stream|mp3|podcast/i.test(k) || (typeof v === 'string' && /\.mp3|\.m4a|audio/i.test(v))) {
        aus.push(`${p} = ${JSON.stringify(v).slice(0, 300)}`);
      }
      audioStellen(v, p, aus);
    }
  }
  return aus;
}

function umgebung(text, muster, n = 8, breite = 220) {
  const treffer = [];
  for (const m of text.matchAll(muster)) {
    treffer.push(text.slice(Math.max(0, m.index - breite), m.index + breite).replace(/\s+/g, ' '));
    if (treffer.length >= n) break;
  }
  return treffer;
}

// 1. Die Artikelseite
try {
  const html = await hole(artikel);
  const mp3 = [...new Set([...html.matchAll(/https?:[^"'\s<>]+?\.(?:mp3|m4a)/gi)].map((m) => m[0]))];
  console.log(`    MP3-Adressen auf der Seite (${mp3.length}):`);
  mp3.slice(0, 10).forEach((u) => console.log('      ' + u));
  console.log('    Umgebung von "audio"-Spielern:');
  umgebung(html, /data-v=|data-config=|mediaplayer|audioplayer|"audio"/gi, 6).forEach((t) => console.log('      … ' + t + ' …'));
} catch (e) { console.log('    FEHLER ' + e.message); }

// 2. Die offene Schnittstelle: Nachrichtenliste
let liste = null;
try {
  liste = JSON.parse(await hole('https://www.tagesschau.de/api2u/news/'));
  const items = liste.news || [];
  console.log(`    Schlüssel oben: ${Object.keys(liste).join(', ')}`);
  console.log(`    ${items.length} Meldungen; Schlüssel der ersten: ${items[0] ? Object.keys(items[0]).join(', ') : '-'}`);
  const mitAudio = items.filter((it) => audioStellen(it).length);
  console.log(`    davon mit Audio-Hinweis: ${mitAudio.length}`);
  for (const it of mitAudio.slice(0, 3)) {
    console.log(`    - ${it.date} | ${it.title} | ${it.details || ''}`);
    audioStellen(it).slice(0, 8).forEach((s) => console.log('        ' + s));
  }
} catch (e) { console.log('    FEHLER ' + e.message); }

// 3. Detail-JSON des Artikels
try {
  const detailUrl = artikel.replace('https://www.tagesschau.de/', 'https://www.tagesschau.de/api2u/').replace(/\.html$/, '.json');
  const d = JSON.parse(await hole(detailUrl));
  console.log(`    Schlüssel: ${Object.keys(d).join(', ')}`);
  const typen = (d.content || []).map((c) => c.type);
  console.log(`    content-Typen: ${[...new Set(typen)].join(', ')}`);
  for (const c of (d.content || []).filter((c) => /audio/i.test(c.type))) {
    console.log('    AUDIO-BLOCK: ' + JSON.stringify(c).slice(0, 1500));
  }
  audioStellen(d).slice(0, 15).forEach((s) => console.log('      ' + s));
} catch (e) { console.log('    FEHLER ' + e.message); }

// 4. Weitere mögliche Quellen
for (const url of [
  'https://www.tagesschau.de/api2u/news/?ressort=wirtschaft',
  'https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml',
  'https://www.tagesschau.de/multimedia/audio/index~rss2.xml',
  'https://www.tagesschau.de/multimedia/audio',
]) {
  try {
    const t = await hole(url);
    if (t.trim().startsWith('{')) {
      const j = JSON.parse(t);
      const items = j.news || [];
      console.log(`    ${items.length} Meldungen, mit Audio-Hinweis: ${items.filter((it) => audioStellen(it).length).length}`);
    } else {
      const items = t.match(/<item[\s>]/gi) || [];
      const enc = t.match(/<enclosure[^>]+>/gi) || [];
      console.log(`    <item>: ${items.length}, <enclosure>: ${enc.length}`);
      enc.slice(0, 3).forEach((e) => console.log('      ' + e));
      const mp3 = [...new Set([...t.matchAll(/https?:[^"'\s<>]+?\.(?:mp3|m4a)/gi)].map((m) => m[0]))];
      console.log(`    MP3-Adressen: ${mp3.length}`);
      mp3.slice(0, 5).forEach((u) => console.log('      ' + u));
      umgebung(t, /<item[\s>]/gi, 2, 400).forEach((x) => console.log('      … ' + x.slice(0, 700) + ' …'));
    }
  } catch (e) { console.log('    FEHLER ' + e.message); }
}

// 5. Wie Titel, MP3 und Länge auf der Audio-Seite zusammenhängen
const entity = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
try {
  const html = await hole('https://www.tagesschau.de/multimedia/audio');
  let n = 0;
  for (const m of html.matchAll(/data-v="([^"]*AU-\d{8}[^"]*)"/g)) {
    console.log('    data-v: ' + entity(m[1]).slice(0, 1800));
    if (++n >= 2) break;
  }
  if (!n) umgebung(html, /AU-\d{8}-\d{4}-\d{4}\.mp3/g, 2, 900).forEach((t) => console.log('      … ' + entity(t) + ' …'));
} catch (e) { console.log('    FEHLER ' + e.message); }

// 6. Eine Audio-Einzelseite aus dem RSS
try {
  const rss = await hole('https://www.tagesschau.de/multimedia/audio/index~rss2.xml');
  const links = [...rss.matchAll(/<link>(https:\/\/www\.tagesschau\.de\/multimedia\/audio\/audio-\d+\.html)<\/link>/g)].map((m) => m[1]);
  console.log(`    Einzelseiten im RSS: ${links.length}`);
  const html = await hole(links[0]);
  const mp3 = [...new Set([...html.matchAll(/https?:[^"'\s<>&]+?\.mp3/gi)].map((m) => m[0]))];
  console.log('    MP3 der Einzelseite: ' + mp3.slice(0, 4).join('  '));
  for (const m of html.matchAll(/data-v="([^"]*\.mp3[^"]*)"/g)) { console.log('    data-v: ' + entity(m[1]).slice(0, 1800)); break; }
  const api = links[0].replace('https://www.tagesschau.de/', 'https://www.tagesschau.de/api2u/').replace(/\.html$/, '.json');
  const j = JSON.parse(await hole(api));
  console.log('    Schlüssel: ' + Object.keys(j).join(', '));
  console.log('    ' + JSON.stringify(j).slice(0, 1500));
} catch (e) { console.log('    FEHLER ' + e.message); }

// 7. Alle Beiträge der Audio-Seite: Zeit, Länge, Titel - wie weit reicht sie zurück?
try {
  const html = await hole('https://www.tagesschau.de/multimedia/audio');
  const liste = [];
  for (const m of html.matchAll(/data-v="([^"]*AU-\d{8}[^"]*)"/g)) {
    try {
      const j = JSON.parse(entity(m[1]));
      const meta = j.mc && j.mc.meta;
      const url = j.mc.streams[0].media[0].url;
      liste.push(`${meta.broadcastedOnDateTime}  ${String(meta.durationSeconds).padStart(4)}s  ${meta.title}  | ${meta.synopsis || ''} | ${url.split('/').pop()}`);
    } catch (e) { liste.push('nicht lesbar: ' + e.message); }
  }
  console.log(`    ${liste.length} Beiträge:`);
  liste.forEach((z) => console.log('      ' + z));
  const weiter = umgebung(html, /pageIndex|weitere|mehr laden|loadMore|nextPage/gi, 4, 160);
  weiter.forEach((t) => console.log('    weiter? … ' + entity(t) + ' …'));
} catch (e) { console.log('    FEHLER ' + e.message); }

// 8. Der Proxy (Apps Script): liefert er die Beiträge?
try {
  const quelle = (await import('node:fs')).readFileSync('index.html', 'utf8');
  const proxy = /const PROXY_URL = "([^"]+)"/.exec(quelle)[1];
  const res = await fetch(proxy + '?mode=tagesschau', { redirect: 'follow' });
  const text = await res.text();
  console.log(`\n### Proxy ?mode=tagesschau\n    HTTP ${res.status}, ${text.length} Zeichen`);
  const j = JSON.parse(text);
  if (j.error) console.log('    FEHLER vom Proxy: ' + j.error);
  const eps = j.episodes || [];
  console.log(`    ${eps.length} Beiträge, aus dem Zwischenspeicher: ${j._cached}`);
  eps.slice(0, 5).forEach((e) => console.log(`      ${e.pubDate} | ${e.duration}s | ${e.title} | ${e.audioUrl}`));
  if (eps.length) console.log('    ältester: ' + eps[eps.length - 1].pubDate);
} catch (e) { console.log('    FEHLER ' + e.message); }
