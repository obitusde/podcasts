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
