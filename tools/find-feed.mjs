/**
 * Sucht zu einer Sendungsseite den Podcast-Feed und beschreibt die neueste
 * Folge.
 *
 * Gedacht fürs Hinzufügen eines Podcasts in die Konfigurationstabelle: Die
 * Feed-Adresse steht selten sichtbar auf der Seite, und bevor man einen
 * Podcast einträgt, will man wissen, wie lang und wie gross seine Folgen
 * sind - davon hängt ab, ob die Transkription vorher verkleinert werden
 * muss.
 *
 * Aufruf: node tools/find-feed.mjs <seiten-adresse oder feed-adresse>
 */

const start = process.argv[2];
if (!start) {
  console.error('Aufruf: node tools/find-feed.mjs <adresse>');
  process.exit(1);
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function hole(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (podcast-konfiguration)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function istFeed(text) {
  return /<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text);
}

// Alle plausiblen Feed-Adressen aus einer HTML-Seite.
function feedKandidaten(html, basis) {
  const treffer = new Set();

  for (const m of html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0]);
    if (href) treffer.add(href[1]);
  }
  for (const m of html.matchAll(/["'](https?:\/\/[^"']*(?:feed\/podcast|\/feed\/|podcast[^"']*\.xml|rss)[^"']*)["']/gi)) {
    treffer.add(m[1]);
  }

  return [...treffer]
    .map((u) => { try { return new URL(u, basis).href; } catch { return null; } })
    .filter(Boolean)
    .filter((u) => !/\.(png|jpg|svg|css|js)(\?|$)/i.test(u));
}

function feedInfos(xml) {
  const tag = (quelle, name) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(quelle);
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  };
  const titel = tag(xml, 'title');
  const items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const folgen = items.slice(0, 3).map((item) => {
    const enc = /<enclosure[^>]*>/i.exec(item);
    const url = enc && /url=["']([^"']+)["']/i.exec(enc[0]);
    const len = enc && /length=["'](\d+)["']/i.exec(enc[0]);
    const dauer = tag(item, 'itunes:duration') || tag(item, 'duration');
    return {
      titel: tag(item, 'title'),
      datum: tag(item, 'pubDate'),
      dauer,
      mb: len ? Number(len[1]) / 1048576 : null,
      url: url ? url[1] : null
    };
  });
  return { titel, anzahl: items.length, folgen };
}

const kandidaten = [];
const ersteSeite = await hole(start);

if (istFeed(ersteSeite)) {
  kandidaten.push(start);
} else {
  kandidaten.push(...feedKandidaten(ersteSeite, start));
  console.log(`Auf der Seite gefunden: ${kandidaten.length} mögliche Adressen\n`);
}

let gefunden = 0;
for (const url of kandidaten.slice(0, 12)) {
  let xml;
  try {
    xml = await hole(url);
  } catch (err) {
    continue;
  }
  if (!istFeed(xml)) continue;

  const info = feedInfos(xml);
  gefunden++;
  console.log('='.repeat(70));
  console.log(`FEED: ${url}`);
  console.log(`Titel: ${info.titel}`);
  console.log(`Folgen im Feed: ${info.anzahl}`);
  info.folgen.forEach((f) => {
    const teile = [f.datum, f.dauer && `Dauer ${f.dauer}`, f.mb && `${f.mb.toFixed(1)} MB`]
      .filter(Boolean).join(' · ');
    console.log(`  - ${f.titel}`);
    console.log(`    ${teile}`);
  });
  console.log('');
}

if (gefunden === 0) {
  console.log('Kein Feed gefunden. Die Adresse der Sendungsseite prüfen oder den Feed direkt angeben.');
  process.exit(1);
}
