/**
 * Holt die Konfiguration aus der Google-Tabelle und schreibt sie als
 * data/config.json ins Repository.
 * ---------------------------------------------------------------------------
 * Warum der Umweg über eine Datei im Repository?
 *
 * Die App könnte die Tabelle auch direkt bei Google lesen. Dann hinge aber
 * bei jedem Start die gesamte Podcastliste daran, dass Google antwortet und
 * die Freigabe-Kopfzeilen mitschickt, die ein Browser für fremde Adressen
 * verlangt. Über das Repository liegt die zuletzt funktionierende Fassung
 * immer unter derselben Adresse wie die App selbst - ohne CORS, und auch
 * dann, wenn Google gerade nicht erreichbar ist.
 *
 * Die Adresse der Tabelle steht in tools/config-quelle.txt (oder in der
 * Umgebungsvariablen CONFIG_URL). Es muss die "Im Web veröffentlichen"-
 * Adresse im CSV-Format sein.
 *
 * Geht beim Lesen etwas schief, endet der Lauf mit einer Fehlermeldung und
 * data/config.json bleibt unverändert. Lieber die Konfiguration von gestern
 * als gar keine.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const QUELLE_PATH = 'tools/config-quelle.txt';
const OUT_PATH = 'data/config.json';

const log = (text) => console.log(text);

/* ------------------------------------------------------------ CSV lesen */

/**
 * Zerlegt CSV nach RFC 4180: Felder in Anführungszeichen dürfen Kommas und
 * Zeilenumbrüche enthalten, zwei Anführungszeichen stehen für eines.
 * Der Beschreibungstext ("Aufbau") braucht genau das.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let feld = '';
  let inQuotes = false;

  const sauber = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < sauber.length; i++) {
    const c = sauber[i];
    if (inQuotes) {
      if (c === '"') {
        if (sauber[i + 1] === '"') { feld += '"'; i++; }
        else inQuotes = false;
      } else feld += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(feld); feld = ''; continue; }
    if (c === '\n') { row.push(feld); rows.push(row); row = []; feld = ''; continue; }
    feld += c;
  }
  row.push(feld);
  rows.push(row);

  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/* ------------------------------------------------------- Werte auslesen */

// Spaltennamen werden locker verglichen: Gross-/Kleinschreibung, Umlaute,
// Klammerzusätze und Leerzeichen sollen keine Rolle spielen.
function spaltenSchluessel(text) {
  return String(text)
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z]/g, '');
}

const JA = ['ja', 'j', 'yes', 'y', 'wahr', 'true', 'x', '1'];
const NEIN = ['nein', 'n', 'no', 'falsch', 'false', '0', ''];

function jaNein(wert, standard = false) {
  const t = String(wert ?? '').trim().toLowerCase();
  if (JA.includes(t)) return true;
  if (NEIN.includes(t)) return false;
  return standard;
}

/**
 * Sekunden aus einem Feld.
 *
 * Erlaubt ist die reine Sekundenzahl ("545"), mm:ss ("9:05") und das, was
 * Google daraus macht, wenn es den Wert für eine Uhrzeit hält ("9:05:00").
 * Letzteres ist kein Sonderfall für Feinschmecker: Tippt man 9:05 in eine
 * Tabellenzelle, wandelt Google das von sich aus um.
 */
function sekunden(wert) {
  const t = String(wert ?? '').trim();
  if (t === '') return null;
  if (/^\d+([.,]\d+)?$/.test(t)) return Math.round(Number(t.replace(',', '.')));

  const teile = t.split(':').map((x) => Number(x));
  if (teile.some((x) => !Number.isFinite(x))) return null;
  if (teile.length === 2) return teile[0] * 60 + teile[1];
  if (teile.length === 3) {
    // Googles Uhrzeit-Form: die Sekundenstelle ist 0, gemeint war mm:ss
    if (teile[2] === 0) return teile[0] * 60 + teile[1];
    return teile[0] * 3600 + teile[1] * 60 + teile[2];
  }
  return null;
}

/* ------------------------------------------------------ Tabelle deuten */

function tabelleZuPodcasts(rows) {
  if (rows.length < 2) throw new Error('Die Tabelle hat keine Datenzeilen');

  const kopf = rows[0].map(spaltenSchluessel);
  const spalte = (name) => kopf.indexOf(spaltenSchluessel(name));

  const idx = {
    id: spalte('ID'),
    aktiv: spalte('Aktiv'),
    name: spalte('Name'),
    feed: spalte('Feed-URL'),
    nurMit: spalte('Nur Titel mit'),
    ohne: spalte('Titel ohne'),
    mindest: spalte('Mindestlänge'),
    werbung: spalte('Werbung'),
    marken: spalte('Sprungmarken'),
    start: spalte('Start'),
    ende: spalte('Ende'),
    aufbau: spalte('Aufbau'),
    schluss: spalte('Schlussmarker'),
    folgen: spalte('Folgen')
  };

  for (const pflicht of ['id', 'name', 'feed']) {
    if (idx[pflicht] === -1) throw new Error(`In der Tabelle fehlt die Spalte "${pflicht}"`);
  }

  const feld = (row, i) => (i === -1 ? '' : String(row[i] ?? '').trim());
  const podcasts = [];
  const gesehen = new Set();

  rows.slice(1).forEach((row, i) => {
    const zeile = i + 2;                       // Zeilennummer wie in der Tabelle
    const id = feld(row, idx.id);
    const name = feld(row, idx.name);
    const feed = feld(row, idx.feed);

    if (!id && !name && !feed) return;         // leere Zeile
    if (!jaNein(feld(row, idx.aktiv), true)) {
      log(`   Zeile ${zeile}: "${name || id}" ist auf nein gestellt - wird übersprungen`);
      return;
    }
    if (!id) throw new Error(`Zeile ${zeile}: Die Spalte ID ist leer`);
    if (!name) throw new Error(`Zeile ${zeile}: Die Spalte Name ist leer`);
    if (!feed) throw new Error(`Zeile ${zeile}: Die Spalte Feed-URL ist leer`);
    if (gesehen.has(id)) throw new Error(`Zeile ${zeile}: Die ID "${id}" kommt doppelt vor`);
    gesehen.add(id);

    const sonderfall = !/^https?:\/\//i.test(feed);
    if (sonderfall && feed !== 'dlf_audio') {
      throw new Error(`Zeile ${zeile}: "${feed}" ist weder eine Adresse noch das Stichwort dlf_audio`);
    }

    const folgen = sekunden(feld(row, idx.folgen));

    podcasts.push({
      id,
      name,
      feed: sonderfall ? null : feed,
      type: sonderfall ? feed : null,
      titleContains: feld(row, idx.nurMit) || null,
      titleExcludes: feld(row, idx.ohne) || null,
      minDurationSeconds: sekunden(feld(row, idx.mindest)),
      werbung: jaNein(feld(row, idx.werbung)),
      sprungmarken: jaNein(feld(row, idx.marken)),
      startSeconds: sekunden(feld(row, idx.start)) || 0,
      endSeconds: sekunden(feld(row, idx.ende)),
      structure: feld(row, idx.aufbau) || null,
      endMarker: feld(row, idx.schluss) || null,
      episodes: folgen && folgen > 0 ? folgen : 1
    });
  });

  if (podcasts.length === 0) throw new Error('Kein einziger Podcast steht auf aktiv');
  return podcasts;
}

/* ---------------------------------------------------------- Hauptteil */

async function main() {
  let url = (process.env.CONFIG_URL || '').trim();
  if (!url && existsSync(QUELLE_PATH)) {
    url = (await readFile(QUELLE_PATH, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) || '';
  }
  if (!url) {
    throw new Error(`Keine Adresse der Tabelle gefunden - sie gehört nach ${QUELLE_PATH}`);
  }

  log(`Tabelle wird gelesen: ${url.slice(0, 80)}...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Tabelle nicht abrufbar (HTTP ${res.status})`);
  const text = await res.text();

  if (/^\s*</.test(text)) {
    throw new Error('Google hat eine Webseite statt CSV geliefert - ist die Tabelle im Web veröffentlicht (Format CSV)?');
  }

  const podcasts = tabelleZuPodcasts(parseCsv(text));

  log(`\n${podcasts.length} Podcasts, in dieser Reihenfolge:`);
  podcasts.forEach((p, i) => {
    const teile = [];
    if (p.werbung) teile.push('Werbung schneiden');
    if (p.sprungmarken) teile.push('Sprungmarken');
    if (p.startSeconds) teile.push(`ab ${p.startSeconds}s`);
    if (p.endSeconds) teile.push(`bis ${p.endSeconds}s`);
    log(`  ${i + 1}. ${p.name}${teile.length ? '  (' + teile.join(', ') + ')' : ''}`);
  });

  await writeFile(OUT_PATH, JSON.stringify({
    updatedAt: new Date().toISOString(),
    podcasts
  }, null, 2) + '\n');
  log(`\nGespeichert: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(`\nFEHLER: ${err.message}`);
  console.error('Die bisherige Konfiguration bleibt unverändert.');
  process.exit(1);
});
