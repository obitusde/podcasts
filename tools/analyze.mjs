/**
 * Werbe- und Themen-Erkennung für Podcast-Folgen
 * ---------------------------------------------------------------------------
 * Läuft als GitHub Action (.github/workflows/analyze.yml), zweimal täglich.
 * Für jede neue Folge der in tools/podcasts.config.json eingetragenen
 * Podcasts:
 *
 *   1. MP3 laden
 *   2. bei OpenRouter transkribieren lassen - mit Wort-Zeitstempeln
 *   3. das Transkript (in feine Zeilen zerlegt) einem günstigen Textmodell
 *      geben, das Werbeblöcke und Themen über ZEILENNUMMERN benennt
 *   4. die Sekunden selbst aus dem Transkript einsetzen
 *
 * Schritt 4 ist der Kern: Lässt man ein Sprachmodell die Audiodatei direkt
 * anhören und nach Sekunden fragen, liegen die Werte um Minuten daneben.
 * Über die Zeilennummern sind sie so genau wie die Transkription.
 *
 * Ergebnis landet in data/analysis.json und wird von der Action committet.
 * index.html liest diese Datei und überspringt damit die Werbung.
 */

import { readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const API = 'https://openrouter.ai/api/v1';
// Transkriptionsmodell. Entscheidend ist nicht die Worterkennung - die war
// bei allen gut -, sondern die Genauigkeit der Zeitstempel rund um Musik:
// Whisper-Turbo setzte dasselbe Wort in drei Läufen auf 1:29, 1:34 und
// 1:37. Deshalb zuerst das genauere Modell, Whisper bleibt Rückfallebene.
// Das erste aus dieser Liste, das es bei OpenRouter gibt, wird genommen.
// MAI-Transcribe 2 wurde getestet und wieder entfernt: Seine Zeitstempel
// waren um die Länge des Werbeblocks verschoben (Themen begannen 59 Sek.
// zu früh, der vordere Werbeblock fehlte ganz). Es bleibt bei Whisper -
// die grosse Variante zuerst, weil ihre Zeitstempel ruhiger sind als die
// der Turbo-Variante.
const STT_PREFERENCE = [
  'openai/whisper-large-v3',         // ca. 0,5 Cent je 10 Min.
  'openai/whisper-large-v3-turbo'    // ca. 0,2 Cent
];
const STT_FALLBACK = 'openai/whisper-large-v3-turbo';
// Das Textmodell entscheidet, was Werbung ist. Die Lite-Variante hat bei
// identischem Transkript unterschiedlich geantwortet (mal fehlte der
// Schlussblock, mal wurde ein Beitrag fälschlich als Werbung markiert),
// deshalb das grössere Modell - der Unterschied sind Bruchteile eines Cents.
// Welches Textmodell genommen wird, entscheidet sich beim Lauf: Das Skript
// fragt die Modell-Liste von OpenRouter ab und nimmt das erste aus dieser
// Reihenfolge, das es dort wirklich gibt. Sonst scheitert ein Lauf still an
// einem Slug, den es nicht (mehr) gibt - genau das ist passiert.
const TEXT_MODEL_PREFERENCE = [
  'google/gemini-3.1-flash',
  'google/gemini-3.5-flash',
  'google/gemini-2.5-flash',
  'google/gemini-3.1-flash-lite'
];
const TEXT_MODEL_FALLBACK = 'google/gemini-3.1-flash-lite';

const CONFIG_PATH = 'tools/podcasts.config.json';
const OUT_PATH = 'data/analysis.json';

const KEEP_EPISODES = 60;      // so viele Analysen bleiben in der Datei

// Die werbefrei geschnittenen Folgen werden als Anhänge einer GitHub-
// Veröffentlichung abgelegt - nicht im Repository selbst, sonst würde seine
// Geschichte mit jeder Folge um rund 9 MB wachsen und liesse sich nie
// wieder verkleinern. Anhänge lassen sich dagegen löschen.
const RELEASE_TAG = 'audio';
// Je Podcast bleibt nur die neueste geschnittene Folge liegen. Sobald die
// Ausgabe des nächsten Tages fertig ist, wird die von gestern gelöscht -
// gehört wird ohnehin nur die aktuelle.
const KEEP_AUDIO_PER_PODCAST = 1;
// Nur frische Folgen werden analysiert: Ist die neueste Folge älter als
// das hier, gibt es heute keine neue Ausgabe (Wochenende, Feiertag) und
// der Lauf endet sofort wieder - ohne Kosten.
const DEFAULT_MAX_AGE_HOURS = 14;
const MAX_AUDIO_MB = 60;
const MIN_CONTENT_SECONDS = 120; // Plausibilität: so viel Inhalt muss übrig bleiben
const LINE_MAX_SECONDS = 8;      // Länge der Transkript-Zeilen fürs Textmodell
const LINE_MAX_WORDS = 22;
// --- Grenzen am Ton messen -----------------------------------------------
// Das Sprachmodell sagt, WO UNGEFÄHR eine Grenze liegt. Wo genau, wird am
// Ton gemessen: An fast jeder Abschnittsgrenze liegt eine kurze Pause.
// Pausen schwanken zwischen zwei Läufen um exakt null Sekunden - anders als
// geschätzte Wort-Zeitstempel.
// Wie leise es sein muss, um als Pause zu gelten, hängt vom Material ab:
// In einer professionell produzierten Sendung ist eine Sprechpause nie
// wirklich still (Raumklang, Musikbett, angeglichene Lautstärke). Mit einer
// festen strengen Schwelle findet man dort GAR KEINE Pause - genau das ist
// passiert. Deshalb wird eine Leiter von Schwellen durchprobiert und die
// erste genommen, die eine sinnvolle Anzahl Pausen liefert.
const SILENCE_LADDER = [
  { db: -35, min: 0.25 },
  { db: -30, min: 0.25 },
  { db: -25, min: 0.3 },
  { db: -20, min: 0.35 },
  { db: -16, min: 0.4 }
];
const SILENCE_MIN_COUNT = 8;    // weniger = die Schwelle war zu streng
const SILENCE_MAX_COUNT = 500;  // mehr = sie war zu grosszügig
const SNAP_WINDOW = 5;           // Suchradius um die geschätzte Grenze

// Sicherheitsregel, wenn im Suchradius KEINE Pause liegt: Die Grenze wandert
// in die Richtung, in der ein Fehler harmlos ist - lieber ein Moment Musik
// als ein fehlender erster Satz.
const SAFETY_CONTENT_START = 1.2; // Inhalt beginnt so viel früher
const SAFETY_AD_START = 0.5;      // Werbung beginnt so viel später

// --- Abschnitte aus Pausen bilden ---------------------------------------
// Die Sendung wird an den gemessenen Sprechpausen in Abschnitte zerlegt.
// Das Sprachmodell entscheidet dann nur noch, WELCHE Abschnitte Werbung
// sind und wo ein Thema beginnt - die Zeiten stehen vorher fest und
// stammen aus der Messung, nicht aus geschätzten Wort-Zeitstempeln.
const BLOCK_PAUSE = 0.4;      // ab dieser Pausenlänge beginnt ein Abschnitt
const BLOCK_MIN_WORDS = 3;    // kürzere Abschnitte mit dem nächsten verbinden
const BLOCK_PAD = 0.15;       // winziger Vorlauf, damit nichts angeschnitten wird

const PAD_BEFORE = 0.3;          // Werbeblock minimal weiter fassen
const PAD_AFTER = 0.4;
// Zwischen dem letzten gesprochenen Werbewort und dem ersten Wort des
// Beitrags liegt oft ein Jingle oder Musik. Im Transkript steht dazu
// nichts, also würde der Werbeblock zu früh enden (gemessen: rund 9
// Sekunden Werbung blieben übrig). Deshalb wird ein Werbeblock bis zum
// ersten Wort danach bzw. ab dem letzten Wort davor ausgedehnt - höchstens
// aber um GAP_MAX_SECONDS, damit ein langer Sprechpausen-Abschnitt nicht
// ganze Beiträge verschluckt.
const GAP_MAX_SECONDS = 20;

// FORCE=1 analysiert auch Folgen neu, die schon im Ergebnis stehen -
// nützlich, wenn Prompt oder Modell geändert wurden.
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
// EPISODES überschreibt beim Start von Hand, wie viele der neuesten Folgen
// geprüft werden - praktisch, um eine Änderung an mehreren Folgen zu testen.
const EPISODES_OVERRIDE = parseInt(process.env.EPISODES || '', 10);
// DEBUG=1 schreibt das komplette Transkript mit Zeilennummern und Zeiten
// ins Protokoll - damit lässt sich nachvollziehen, warum eine Grenze sitzt,
// wo sie sitzt.
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('FEHLER: Das Repository-Secret OPENROUTER_API_KEY fehlt.');
  console.error('Anlegen unter: Settings -> Secrets and variables -> Actions -> New repository secret');
  process.exit(1);
}

const log = (...args) => console.log(...args);
const fmt = (seconds) => {
  const t = Math.round(seconds);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/* --------------------------------------------------------------- Feed lesen */

function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tagText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

function parseDuration(text) {
  if (!text) return null;
  const parts = String(text).trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

async function fetchEpisodes(feedUrl) {
  const res = await fetch(feedUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  const xml = await res.text();

  const episodes = [];
  for (const m of xml.matchAll(/<item[\s\S]*?<\/item>/gi)) {
    const item = m[0];
    const enclosure = /<enclosure[^>]*url=["']([^"']+)["']/i.exec(item);
    if (!enclosure) continue;
    const pubDate = tagText(item, 'pubDate');
    episodes.push({
      guid: tagText(item, 'guid') || enclosure[1],
      title: tagText(item, 'title') || '(ohne Titel)',
      audioUrl: enclosure[1],
      pubDate: pubDate,
      pubDateMs: pubDate ? Date.parse(pubDate) : NaN,
      durationSeconds: parseDuration(tagText(item, 'itunes:duration'))
    });
    if (episodes.length >= 5) break;
  }
  return episodes;
}

/* ----------------------------------------------------------- Transkription */

async function transcribe(audioBase64, model) {
  const res = await fetch(`${API}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input_audio: { data: audioBase64, format: 'mp3' },
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word']
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Transkription HTTP ${res.status}: ${text.slice(0, 300)}`);

  const data = JSON.parse(text);
  const body = data.verbose_json || data.transcription || data;
  const words = body.words || [];
  const segments = body.segments || [];

  // Whisper-Abschnitte sind 15-20 Sekunden lang - zu grob, um eine
  // Werbegrenze darauf zu legen. Aus den Wort-Zeiten bauen wir feinere
  // Zeilen von höchstens 8 Sekunden.
  if (words.length > 0) {
    const lines = linesFromWords(words);
    if (lines.length > 0) return { lines, words: normalizeWords(words), source: `${words.length} Wörter` };
  }

  const lines = segments
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: (s.text || '').trim() }))
    .filter((s) => Number.isFinite(s.start) && s.text);
  return { lines, words: [], source: `${segments.length} Abschnitte` };
}

function normalizeWords(words) {
  return words
    .map((w) => ({
      start: Number(w.start),
      text: String(w.word ?? w.text ?? '').trim()
    }))
    .filter((w) => Number.isFinite(w.start) && w.text);
}

// Für den Vergleich: Kleinschreibung, Satzzeichen weg.
function plainWord(text) {
  return String(text).toLowerCase().replace(/[^\wäöüß]/g, '');
}

// Bei Musik und Jingles erfindet Whisper regelmässig Wörter ("Musik",
// "Vielen Dank", "Untertitel von ..."). Die dürfen weder ein Thema
// einleiten noch einen Werbeblock beenden, sonst landet die Grenze mitten
// im Jingle - hörbar als Musikfetzen vor dem Beitrag.
const FILLER_WORDS = new Set([
  'musik', 'music', 'applaus', 'untertitel', 'untertitelung', 'copyright',
  'swr', 'zdf', 'ard', 'vielen', 'dank', 'danke', 'ende', 'amara', 'org'
]);

function isFiller(text) {
  const w = plainWord(text);
  return w === '' || FILLER_WORDS.has(w);
}

// Erstes echtes Wort ab einem Zeitpunkt (Füllwörter werden übersprungen).
function firstRealWordAfter(words, time, limitSeconds) {
  for (const w of words) {
    if (w.start < time - 0.01) continue;
    if (w.start > time + limitSeconds) return null;
    if (!isFiller(w.text)) return w.start;
  }
  return null;
}

/**
 * Sucht die genaue Sekunde, in der ein Thema beginnt.
 * Das Modell nennt die Zeile und die ersten Wörter des Themas. Die Zeile
 * allein reicht nicht: Das Schlagwort ("Notenbanken.", "Audi.", "Börse.")
 * steht oft noch am Ende der vorherigen Zeile, der Sprung käme dann ein
 * paar Sekunden zu spät - hörbar mitten im Satz davor. Über die Wörter
 * finden wir den exakten Einsatz.
 */
function findWordStart(words, firstWords, lineStart) {
  if (!words.length || !firstWords) return null;

  const needle = String(firstWords).split(/\s+/)
    .filter((w) => !isFiller(w))   // "Musik Bundespräsident." -> "Bundespräsident"
    .map(plainWord).filter(Boolean).slice(0, 3);
  if (needle.length === 0) return null;

  let best = null;
  for (let i = 0; i + needle.length <= words.length; i++) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (plainWord(words[i + k].text) !== needle[k]) { hit = false; break; }
    }
    if (!hit) continue;
    // Die Stelle nehmen, die der vom Modell genannten Zeile am nächsten ist
    const distance = Math.abs(words[i].start - lineStart);
    if (distance > 30) continue; // weit weg -> anderes Vorkommen im Text
    if (!best || distance < best.distance) best = { start: words[i].start, distance };
  }
  return best ? best.start : null;
}

/**
 * Zieht einen Themenstart auf das Ankündigungs-Schlagwort zurück.
 *
 * Die Sendung kündigt jedes Thema mit einem einzelnen Wort an: "Notenbanken.",
 * "Audi.", "Börse.", "Mercedes.". Das Textmodell nennt mal dieses Wort als
 * Themenanfang, mal erst den Satz danach - dann setzt der Sprung ein paar
 * Sekunden zu spät ein und man landet mitten im Satz davor.
 * Deshalb hier ohne Modell: Steht unmittelbar vor dem gefundenen Start ein
 * Wort, das für sich allein einen Satz bildet, beginnt das Thema dort.
 */
function snapToHeadline(words, startTime) {
  const idx = words.findIndex((w) => w.start >= startTime - 0.05);
  if (idx < 2) return startTime;

  const endsSentence = (w) => /[.!?:]$/.test(w.text);
  // Ein Füllwort aus dem Jingle ("Musik") trennt genauso wie ein Satzende.
  const isBoundary = (w) => isFiller(w.text) || endsSentence(w);

  for (let back = 1; back <= 2; back++) {
    const candidate = words[idx - back];
    const before = words[idx - back - 1];
    if (!candidate || !before) break;
    if (startTime - candidate.start > 8) break;        // zu weit weg
    if (isFiller(candidate.text)) continue;            // "Musik" o.ä. überspringen
    if (endsSentence(candidate) && isBoundary(before)) {
      return candidate.start;                          // allein stehender Satz = Schlagwort
    }
  }
  return startTime;
}

function linesFromWords(words) {
  const lines = [];
  let current = null;

  for (const w of words) {
    const start = Number(w.start);
    const end = Number.isFinite(Number(w.end)) ? Number(w.end) : start;
    const text = String(w.word ?? w.text ?? '').trim();
    if (!Number.isFinite(start) || !text) continue;

    if (!current) {
      current = { start, end, text, count: 1 };
      continue;
    }

    current.text += (/^[.,;:!?]/.test(text) ? '' : ' ') + text;
    current.end = end;
    current.count++;

    const long = current.end - current.start >= LINE_MAX_SECONDS || current.count >= LINE_MAX_WORDS;
    const sentenceEnd = /[.!?]$/.test(text) && current.end - current.start >= 3;
    if (long || sentenceEnd) {
      lines.push({ start: current.start, end: current.end, text: current.text });
      current = null;
    }
  }
  if (current) lines.push({ start: current.start, end: current.end, text: current.text });
  return lines;
}

/* ----------------------------------------------- Pausen im Ton suchen */

/**
 * Sucht mit ffmpeg alle Stellen, an denen es kurz still ist.
 * ffmpeg ist auf den GitHub-Rechnern vorinstalliert; der Lauf dauert für
 * eine 10-Minuten-Datei wenige Sekunden und kostet nichts.
 */
async function detectSilencesAt(filePath, db, min) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', filePath,
    '-af', `silencedetect=noise=${db}dB:d=${min}`,
    '-f', 'null', '-'
  ], { maxBuffer: 64 * 1024 * 1024 });

  const silences = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[0-9.]+)/.exec(line);
    const e = /silence_end:\s*(-?[0-9.]+)/.exec(line);
    if (s) start = parseFloat(s[1]);
    else if (e && start !== null) {
      const end = parseFloat(e[1]);
      if (end > start) silences.push([start, end]);
      start = null;
    }
  }
  return silences;
}

/**
 * Die echte Länge der Datei, gemessen mit ffprobe.
 *
 * Darauf kommt es an: Der Player vergleicht später diese Länge mit der
 * Datei, die er selbst geladen hat. Weicht sie ab, hat der Anbieter eine
 * andere Fassung ausgeliefert und die Marken gelten nicht. Die Länge aus
 * dem Transkript taugt dafür nicht - Whisper erfindet am Dateiende gern
 * noch ein paar Sekunden.
 */
async function probeDuration(filePath) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const seconds = Number(String(stdout).trim());
    return isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch (err) {
    return 0;
  }
}

async function detectSilences(filePath) {
  let best = [];
  for (const step of SILENCE_LADDER) {
    try {
      const found = await detectSilencesAt(filePath, step.db, step.min);
      log(`   Pausen bei ${step.db} dB / ${step.min}s: ${found.length}`);
      if (found.length > best.length && found.length <= SILENCE_MAX_COUNT) best = found;
      if (found.length >= SILENCE_MIN_COUNT && found.length <= SILENCE_MAX_COUNT) return found;
    } catch (err) {
      log(`   Pausen-Messung nicht möglich (${err.message})`);
      return [];
    }
  }
  return best;
}

/**
 * Rastet eine geschätzte Grenze auf die passende Pause ein.
 *
 *   kind 'contentStart' -> Inhalt beginnt: Ende einer Pause DAVOR
 *   kind 'adStart'      -> Werbung beginnt: Anfang einer Pause DANACH
 *
 * Die Richtung ist entscheidend. Die Sendung spricht
 *   "... nicht. [Pause] Notenbanken. [Pause] Die US-Notenbank ..."
 * Nimmt man einfach die nächstgelegene Pause, erwischt man die NACH dem
 * Schlagwort und springt darüber hinweg - genau das ist passiert, alles
 * lag danach sieben Sekunden zu spät. Deshalb: Für einen Inhaltsanfang
 * zählen nur Pausen, die vorher enden; für einen Werbeanfang nur solche,
 * die danach beginnen. Gesucht wird jeweils die nächstgelegene.
 */
function snapToSilence(silences, time, kind) {
  const TOLERANCE = 0.5; // kleine Unschärfe der geschätzten Wortzeit

  const candidates = silences
    .map(([from, to]) => ({ at: kind === 'contentStart' ? to : from, length: to - from }))
    .filter((c) => Math.abs(c.at - time) <= SNAP_WINDOW)
    .filter((c) => (kind === 'contentStart' ? c.at <= time + TOLERANCE : c.at >= time - TOLERANCE));

  if (candidates.length === 0) {
    return {
      at: kind === 'contentStart' ? time - SAFETY_CONTENT_START : time + SAFETY_AD_START,
      snapped: false
    };
  }

  candidates.sort((a, b) => Math.abs(a.at - time) - Math.abs(b.at - time));
  return { at: candidates[0].at, snapped: true, length: candidates[0].length };
}

/**
 * Zerlegt die Folge an den gemessenen Pausen in Abschnitte.
 * Jeder Abschnitt kennt seine Anfangs- und Endzeit sowie die Pause davor
 * und danach - daraus werden später die Werbegrenzen gebildet.
 */
function buildBlocks(words, silences, duration) {
  const cuts = silences.filter(([from, to]) => to - from >= BLOCK_PAUSE);

  const raw = [];
  let start = 0;
  let pauseBefore = null;

  for (const [from, to] of cuts) {
    if (from <= start + 0.05) {        // Pause ganz am Anfang
      start = Math.max(start, to);
      pauseBefore = [from, to];
      continue;
    }
    raw.push({ start, end: from, pauseBefore, pauseAfter: [from, to] });
    start = to;
    pauseBefore = [from, to];
  }
  if (start < duration - 0.2) raw.push({ start, end: duration, pauseBefore, pauseAfter: null });

  // Wörter den Abschnitten zuordnen
  raw.forEach((b) => {
    b.words = words.filter((w) => w.start >= b.start - 0.3 && w.start < b.end + 0.3);
    b.text = b.words.map((w) => w.text).join(' ').trim();
  });

  // Sehr kurze Abschnitte werden mit dem FOLGENDEN verbunden, nie mit dem
  // vorherigen. Grund: Die Themen werden mit einem einzelnen Schlagwort
  // angekündigt ("Notenbanken.", "Audi."), das zwischen zwei Pausen steht
  // und damit einen winzigen eigenen Abschnitt bildet. Es gehört zum
  // Beitrag danach - hängt man es nach hinten an, landet es im Werbeblock
  // davor und der Beitrag beginnt mitten im Satz.
  // Reine Musik-Abschnitte bleiben stehen; sie sind ein guter Hinweis auf
  // eine Abschnittsgrenze.
  const blocks = [];
  let pending = null;

  for (const b of raw) {
    if (pending) {
      b.start = pending.start;
      b.pauseBefore = pending.pauseBefore;
      b.words = pending.words.concat(b.words);
      b.text = (pending.text + ' ' + b.text).trim();
      pending = null;
    }
    if (b.words.length > 0 && b.words.length < BLOCK_MIN_WORDS) {
      pending = b;   // auf den nächsten Abschnitt warten
      continue;
    }
    blocks.push(b);
  }

  if (pending) {                       // ganz am Schluss: nichts folgt mehr
    const last = blocks[blocks.length - 1];
    if (last) {
      last.end = pending.end;
      last.pauseAfter = pending.pauseAfter;
      last.text = (last.text + ' ' + pending.text).trim();
    } else {
      blocks.push(pending);
    }
  }

  blocks.forEach((b) => {
    if (!b.text) b.text = '[Musik oder Stille]';
  });
  return blocks;
}

/* --------------------------------- Werbung und Themen auf Abschnitts-Basis */

function buildBlockPrompt(blocks, structure) {
  const list = blocks
    .map((b, i) => `[${i}] ${fmt(b.start)} ${b.text.slice(0, 220)}`)
    .join('\n');

  return [
    'Das ist eine deutsche Podcast-Folge, zerlegt in Abschnitte. Die Abschnitte wurden an den Sprechpausen getrennt; jede Zeile ist ein Abschnitt in der Form "[Nummer] Zeit Text". "[Musik oder Stille]" heisst: dort wird nicht gesprochen.',
    structure ? `\nAufbau dieser Sendung: ${structure}` : '',
    '',
    'Aufgabe 1 - Werbung: Nenne die Nummern ALLER Abschnitte, die zur Werbung gehören. Werbung ist:',
    '- Sponsorenhinweise ("präsentiert von", "unterstützt von", "Werbung", "Anzeige")',
    '- beworbene Anbieter samt Produktbeschreibung, Rabattcode oder Aufruf ("jetzt testen", "mehr unter ...")',
    '- Eigenwerbung: Abo-, Newsletter- und Veranstaltungshinweise, Empfehlungen anderer Podcasts',
    '- die Ankündigung der Werbepause ("Nach einer kurzen Unterbrechung geht es gleich weiter", "Bleiben Sie dran")',
    '- Musik-Abschnitte, die zwischen solchen Abschnitten liegen',
    'KEINE Werbung: die Vorstellung der Themen am Anfang, Begrüssung und Verabschiedung, normale Berichte über Firmen und Hinweise der Redaktion auf eigene Berichte oder Kollegen.',
    '',
    'Aufgabe 2 - Themen: Nenne für jedes Thema des redaktionellen Teils die Nummer des Abschnitts, in dem es BEGINNT, einen kurzen deutschen Titel (höchstens 40 Zeichen) und unter "beginnt" die ERSTEN VIER BIS SECHS WÖRTER des Themas - wortwörtlich abgeschrieben, genau so wie sie im Abschnittstext stehen, ohne etwas zu ergänzen oder umzustellen. Die Themen werden oft mit einem einzelnen Schlagwort angekündigt ("Notenbanken.", "Audi.") - dann ist der Abschnitt gemeint, in dem dieses Schlagwort steht, und "beginnt" fängt mit diesem Schlagwort an. Ein Thema darf nicht in einem Werbeabschnitt beginnen. 3 bis 12 Themen.',
    '',
    'Antworte AUSSCHLIESSLICH mit diesem JSON, ohne Markdown und ohne weiteren Text:',
    '{"werbung":[0,1,2],"themen":[{"block":5,"titel":"Zollstreit mit China","beginnt":"Zollstreit. Die Europäische Union hat"}]}',
    '',
    'Abschnitte:',
    list
  ].join('\n');
}

// Vergleichsform eines Wortes: nur Buchstaben und Ziffern, klein.
function normWord(text) {
  return String(text).toLowerCase().replace(/[^a-zäöüß0-9]+/g, '');
}

/**
 * Sucht die vom Modell genannten Anfangswörter im gemessenen Wortstrom und
 * liefert die Zeit des ersten Wortes.
 *
 * Warum: Die Abschnittsgrenze ist nur so genau wie die Wahl des Abschnitts.
 * Nennt das Modell den Abschnitt davor, sitzt die Marke einen Satz zu früh -
 * beim Thema "Handelspolitik" waren das 14 Sekunden. Die Wörter dagegen sind
 * eindeutig, und ihre Zeiten sind gemessen, nicht geschätzt. Gesucht wird nur
 * in der Umgebung des genannten Abschnitts, damit ein Wort, das später noch
 * einmal fällt, die Marke nicht verschleppt.
 */
function findPhraseStart(words, phrase, near) {
  const needle = String(phrase || '').split(/\s+/).map(normWord).filter(Boolean);
  if (needle.length < 2) return null;

  // Erst die lange Wortfolge versuchen, dann kürzere - das Modell schreibt
  // gelegentlich ein Wort anders, als Whisper es verstanden hat.
  for (let len = Math.min(needle.length, 5); len >= 2; len--) {
    const treffer = [];
    for (let i = 0; i + len <= words.length; i++) {
      let passt = true;
      for (let j = 0; j < len; j++) {
        if (normWord(words[i + j].text) !== needle[j]) { passt = false; break; }
      }
      if (passt) treffer.push(words[i].start);
    }
    if (treffer.length > 0) {
      treffer.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
      return treffer[0];
    }
  }
  return null;
}

/**
 * Fragt das Modell, welche Abschnitte Werbung sind und wo Themen beginnen -
 * und setzt die Zeiten aus den gemessenen Pausen ein.
 */
async function findAdsAndChaptersFromBlocks(blocks, structure, endMarker, duration) {
  const model = await pickTextModel();
  const prompt = buildBlockPrompt(blocks, structure);

  let res = await askTextModel(prompt, model);
  if (!res.ok && model !== TEXT_MODEL_FALLBACK) {
    log(`   ${model}: HTTP ${res.status} - zweiter Versuch mit ${TEXT_MODEL_FALLBACK}`);
    textModelCache = TEXT_MODEL_FALLBACK;
    res = await askTextModel(prompt, TEXT_MODEL_FALLBACK);
  }
  if (!res.ok) throw new Error(`Analyse HTTP ${res.status}: ${res.text.slice(0, 300)}`);

  const content = JSON.parse(res.text).choices?.[0]?.message?.content;
  if (!content) throw new Error('Keine Antwort vom Analyse-Modell');
  const parsed = JSON.parse(content.replace(/```json/gi, '').replace(/```/g, '').trim());
  log('   Antwort: ' + JSON.stringify(parsed));

  const adBlocks = new Set((parsed.werbung || []).filter((i) => blocks[i]));

  // Fester Schlussmarker: ab dem Abschnitt mit der Verabschiedung ist alles
  // Werbung, unabhängig vom Modell.
  if (endMarker) {
    const needle = endMarker.toLowerCase();
    const idx = blocks.findIndex((b) => b.text.toLowerCase().includes(needle));
    if (idx !== -1) {
      for (let i = idx; i < blocks.length; i++) adBlocks.add(i);
      log(`   Schlussmarker "${endMarker}" in Abschnitt ${idx} (${fmt(blocks[idx].start)}) - ab dort Werbung`);
    } else {
      log(`   Hinweis: Schlussmarker "${endMarker}" nicht gefunden`);
    }
  }

  // Zusammenhängende Werbeabschnitte zu Bereichen zusammenfassen. Die
  // Grenzen sind gemessene Pausen: Start = Beginn der Pause davor (direkt
  // nach dem letzten Inhaltswort), Ende = Ende der Pause danach (dort
  // setzt der Inhalt wieder ein).
  const sorted = [...adBlocks].sort((a, b) => a - b);
  const ads = [];
  let group = [];
  const flush = () => {
    if (group.length === 0) return;
    const first = blocks[group[0]];
    const last = blocks[group[group.length - 1]];
    const from = first.pauseBefore ? first.pauseBefore[0] : first.start;
    const to = last.pauseAfter ? last.pauseAfter[1] : duration;
    ads.push([Math.max(0, from), to]);
    group = [];
  };
  sorted.forEach((i) => {
    if (group.length === 0 || i === group[group.length - 1] + 1) group.push(i);
    else { flush(); group = [i]; }
  });
  flush();

  const chapters = (parsed.themen || [])
    .map((c) => {
      const block = blocks[c.block];
      if (!block || !c.titel) return null;
      const titel = String(c.titel).slice(0, 60);

      // Nur in der Umgebung des genannten Abschnitts suchen (zwei davor, zwei
      // danach) - so fängt die Suche einen Griff daneben ab, läuft aber nicht
      // quer durch die Folge.
      const von = blocks[Math.max(0, c.block - 2)].start;
      const bis = blocks[Math.min(blocks.length - 1, c.block + 2)].end;
      const umgebung = [];
      for (let i = Math.max(0, c.block - 2); i <= Math.min(blocks.length - 1, c.block + 2); i++) {
        umgebung.push(...blocks[i].words);
      }
      const treffer = findPhraseStart(umgebung, c.beginnt, block.start);
      const gefunden = treffer !== null && treffer >= von - 0.5 && treffer <= bis + 0.5;
      if (gefunden && Math.abs(treffer - block.start) > 0.5) {
        log(`   Thema "${titel}": Abschnitt ${c.block} beginnt ${fmt(block.start)}, die Worte "${c.beginnt}" aber ${fmt(treffer)} - es gelten die Worte`);
      } else if (!gefunden && c.beginnt) {
        log(`   Thema "${titel}": "${c.beginnt}" nicht wiedergefunden - es gilt der Abschnittsanfang ${fmt(block.start)}`);
      }

      const start = gefunden ? treffer : block.start;
      return { start: Math.max(0, start - BLOCK_PAD), title: titel };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  return { ads: trimAdsByChapters(ads, chapters), chapters };
}

/* ------------------------------------------------- Werbung und Themen finden */

function buildPrompt(lines, structure) {
  const transcript = lines.map((l, i) => `[${i}] ${Math.round(l.start)}s: ${l.text}`).join('\n');

  return [
    'Das ist das Transkript einer deutschen Podcast-Folge. Jede Zeile hat die Form "[Nummer] Sekunde: Text".',
    structure ? `\nAufbau dieser Sendung: ${structure}` : '',
    '',
    'Aufgabe 1 - Werbung: Finde ALLE Werbeblöcke und gib jeweils die erste und die letzte Zeile des Blocks an. Als Werbung gilt:',
    '- jeder Sponsorenhinweis, auch kurze ("präsentiert von", "unterstützt von", "in Zusammenarbeit mit", "Werbung", "Anzeige")',
    '- jeder beworbene Anbieter samt Produktbeschreibung, Rabattcode oder Aufruf wie "jetzt testen", "mehr unter ..."',
    '- Eigenwerbung: Abo-, Newsletter- und App-Hinweise, Empfehlungen anderer Podcasts, Spendenaufrufe',
    '- der Abspann am Schluss, sobald er zu solchen Hinweisen übergeht',
    '- die Ankündigung der Werbepause direkt davor ("Nach einer kurzen Unterbrechung geht es gleich weiter", "Bleiben Sie dran") - sie gehört mit in den Block',
    'KEINE Werbung sind: die Vorstellung der Themen am Anfang, Begrüssung und Verabschiedung des Moderators sowie normale journalistische Berichte über Firmen.',
    'Ebenfalls KEINE Werbung: Hinweise der Redaktion auf eigene Berichte, Kollegen oder Recherchen mitten in einem Thema (etwa "unser Chefautor recherchiert vor Ort", "das berichten meine Kolleginnen"). Das ist redaktioneller Text, auch wenn es um das eigene Haus geht.',
    'Entscheidend ist der Aufruf an die Hörer: kaufen, testen, abonnieren, anmelden, teilnehmen, einen Code eingeben oder eine Adresse aufrufen. Fehlt so ein Aufruf, ist es keine Werbung.',
    'Setze die Grenzen so eng wie möglich: die erste Zeile des Blocks ist die erste Werbezeile, die letzte Zeile die letzte - die darauffolgende Zeile muss wieder redaktioneller Inhalt sein.',
    '',
    'Aufgabe 2 - Themen: Gliedere den redaktionellen Teil in 3 bis 12 Themen. Gib für jedes Thema an: die Zeilennummer, in der es beginnt, einen kurzen deutschen Titel (höchstens 40 Zeichen, keine Anführungszeichen) und unter "start" die ersten zwei bis drei Wörter des Themas - genau so abgeschrieben, wie sie im Transkript stehen. Oft ist das erste Wort ein Schlagwort wie "Notenbanken." oder "Audi."; steht es noch am Ende der vorherigen Zeile, schreibe es trotzdem bei "start" hin und gib die Zeilennummer an, in der der Beitrag weitergeht.',
    'Ein Thema darf NIE in einem Werbeblock beginnen. Die Themenvorstellung am Anfang ist kein eigenes Thema. Gibt es einen Sport-, Wetter- oder Boulevardblock, soll er ein eigenes Thema mit passendem Titel sein.',
    '',
    'Antworte AUSSCHLIESSLICH mit diesem JSON, ohne Markdown und ohne weiteren Text:',
    '{"ads":[{"von":0,"bis":4}],"themen":[{"zeile":5,"titel":"Zollstreit mit China","start":"Zoelle. Die EU"}]}',
    '',
    'Transkript:',
    transcript
  ].join('\n');
}

let textModelCache = null;
let sttModelCache = null;
let availableModelIds = null;

/**
 * Liste der verfügbaren Modelle (einmal pro Lauf).
 * Zwei Abfragen sind nötig: Transkriptionsmodelle stehen bei OpenRouter
 * NICHT im Standard-Katalog, sondern nur unter
 * ?output_modalities=transcription. Ohne die zweite Abfrage fällt die
 * Auswahl still auf das Modell zurück, das gerade ersetzt werden soll.
 */
async function loadModelIds() {
  if (availableModelIds) return availableModelIds;
  availableModelIds = new Set();

  for (const url of [`${API}/models`, `${API}/models?output_modalities=transcription`]) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
        log(`Modell-Liste (${url}): HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      (data.data || []).forEach((m) => availableModelIds.add(m.id));
    } catch (err) {
      log(`Modell-Liste nicht abrufbar (${err.message})`);
    }
  }

  if (DEBUG) {
    const stt = [...availableModelIds].filter((id) => /transcribe|whisper|asr|scribe|voxtral|chirp/i.test(id));
    log(`Modelle insgesamt: ${availableModelIds.size}`);
    log('Davon Transkription: ' + (stt.sort().join(', ') || 'keine gefunden'));
  }
  return availableModelIds;
}

// Transkriptionsmodell wählen: STT=<slug> erzwingt eines (für Vergleiche).
async function pickSttModel() {
  if (sttModelCache) return sttModelCache;
  if (process.env.STT) {
    sttModelCache = process.env.STT;
    log(`Transkription: ${sttModelCache} (von Hand vorgegeben)`);
    return sttModelCache;
  }
  const ids = await loadModelIds();
  sttModelCache = STT_PREFERENCE.find((id) => ids.has(id)) || STT_FALLBACK;
  log(`Transkription: ${sttModelCache}`);
  return sttModelCache;
}

async function pickTextModel() {
  if (textModelCache) return textModelCache;
  const ids = await loadModelIds();
  textModelCache = TEXT_MODEL_PREFERENCE.find((id) => ids.has(id)) || TEXT_MODEL_FALLBACK;
  log(`Textmodell: ${textModelCache}`);
  return textModelCache;
}

async function askTextModel(prompt, model) {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    })
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function findAdsAndChapters(lines, words, structure, endMarker) {
  const prompt = buildPrompt(lines, structure);

  const model = await pickTextModel();
  let res = await askTextModel(prompt, model);
  if (!res.ok) {
    log(`   ${model} antwortet mit HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    if (model !== TEXT_MODEL_FALLBACK) {
      log(`   zweiter Versuch mit ${TEXT_MODEL_FALLBACK}`);
      textModelCache = TEXT_MODEL_FALLBACK;
      res = await askTextModel(prompt, TEXT_MODEL_FALLBACK);
    }
  }

  const text = res.text;
  if (!res.ok) throw new Error(`Analyse HTTP ${res.status}: ${text.slice(0, 300)}`);

  const content = JSON.parse(text).choices?.[0]?.message?.content;
  if (!content) throw new Error('Keine Antwort vom Analyse-Modell');

  const parsed = JSON.parse(content.replace(/```json/gi, '').replace(/```/g, '').trim());
  log('   Antwort:', JSON.stringify(parsed));

  const ads = (parsed.ads || [])
    .map((a) => {
      const fromIdx = a.von;
      const toIdx = a.bis ?? a.von;
      const from = lines[fromIdx];
      const to = lines[toIdx];
      if (!from || !to) return null;

      // Anfang: bis zum Ende des letzten Wortes davor zurückziehen
      const prev = lines[fromIdx - 1];
      const start = prev
        ? Math.max(prev.end, from.start - GAP_MAX_SECONDS)
        : Math.max(0, from.start - PAD_BEFORE);

      // Ende: bis zum ersten echten Wort danach ausdehnen. Das deckt den
      // Jingle ab - auch dann, wenn Whisper ihn als "Musik" oder "Vielen
      // Dank" ins Transkript geschrieben hat.
      const next = lines[toIdx + 1];
      const realWord = firstRealWordAfter(words, to.end, GAP_MAX_SECONDS);
      const candidate = realWord !== null ? realWord - 0.05 : (next ? next.start - 0.05 : to.end + PAD_AFTER);
      const end = Math.min(Math.max(to.end + PAD_AFTER, candidate), to.end + GAP_MAX_SECONDS);

      return [Math.max(0, start), end];
    })
    .filter(Boolean);

  // Feste Regel pro Podcast: Ab der Verabschiedung des Moderators kommt nur
  // noch Werbung. Das Modell übersieht diesen Block manchmal - diese Zeile
  // findet ihn verlässlich, ganz ohne Modell.
  if (endMarker) {
    const needle = endMarker.toLowerCase();
    const idx = lines.findIndex((l) => l.text.toLowerCase().includes(needle));
    if (idx !== -1) {
      ads.push([lines[idx].start, lines[lines.length - 1].end + 1]);
      log(`   Schlussmarker "${endMarker}" in Zeile ${idx} (${fmt(lines[idx].start)}) - ab dort Werbung`);
    } else {
      log(`   Hinweis: Schlussmarker "${endMarker}" nicht gefunden`);
    }
  }

  const chapters = (parsed.themen || [])
    .map((c) => {
      const line = lines[c.zeile];
      if (!line || !c.titel) return null;
      // Zuerst die Wort-Zeit versuchen, sonst den Zeilenanfang nehmen.
      const wordStart = findWordStart(words, c.start, line.start);
      const raw = wordStart !== null ? wordStart : line.start;
      const start = snapToHeadline(words, raw);
      if (Math.abs(start - line.start) > 0.6) {
        log(`   Thema "${c.titel}": ${fmt(line.start)} (Zeile) -> ${fmt(start)}${start !== raw ? ' (Schlagwort)' : ' (erstes Wort)'}`);
      }
      return { start: Math.max(0, start - PAD_BEFORE), title: String(c.titel).slice(0, 60) };
    })
    .filter(Boolean);

  return { ads: trimAdsByChapters(ads, chapters), chapters };
}

/**
 * Abschliessende Prüfung an der echten Datei: Vor jeder Marke, an der die
 * Wiedergabe einsetzt (Themenanfang, Ende eines Werbeblocks), MUSS eine
 * gemessene Pause liegen. Sonst beginnt die Wiedergabe mitten im Satz.
 *
 * Fehlt die Pause, wird die Marke auf die letzte Pause davor zurückgezogen
 * (höchstens PAUSE_LOOKBACK Sekunden). Jede Marke wird protokolliert - damit
 * lässt sich der Erfolg ablesen, ohne hineinzuhören.
 */
const PAUSE_NEAR = 0.6;       // so nah gilt eine Pause als "direkt davor"
const PAUSE_LOOKBACK = 4;     // so weit wird notfalls zurückgezogen

function pauseBeforeMark(silences, time, floor = 0) {
  const direct = silences.find(([, end]) => end >= time - PAUSE_NEAR && end <= time + 0.25);
  if (direct) return { at: Math.max(floor, direct[1] - 0.05), status: 'Pause davor' };

  const earlier = silences
    .filter(([, end]) => end < time && time - end <= PAUSE_LOOKBACK && end - 0.05 >= floor)
    .sort((a, b) => b[1] - a[1])[0];
  if (earlier) {
    return { at: Math.max(floor, earlier[1] - 0.05), status: 'auf Pause zurückgezogen' };
  }
  return { at: time, status: 'KEINE Pause gefunden' };
}

/**
 * Zieht alle Einstiegsmarken auf Pausen und schreibt das Ergebnis ins
 * Protokoll. Gibt die geprüften Werte zurück.
 */
function alignMarksToPauses(adRanges, chapters, silences, duration) {
  if (silences.length === 0) {
    log('   Prüfung übersprungen: keine Pausen gemessen');
    return { adRanges, chapters };
  }

  let good = 0;
  let total = 0;

  const checkedAds = adRanges.map(([from, to]) => {
    if (to >= duration - 1) return [from, to];       // Schlussblock: kein Einstieg danach
    total++;
    const r = pauseBeforeMark(silences, to, from + 1);
    if (r.status === 'Pause davor') good++;
    log(`   Werbe-Ende ${fmt(to)} -> ${fmt(r.at)}: ${r.status}`);
    return [from, r.at];
  });

  const checkedChapters = chapters.map((c) => {
    if (c.start <= 0.5) return c;                    // Anfang der Folge
    total++;
    const r = pauseBeforeMark(silences, c.start);
    if (r.status === 'Pause davor') good++;
    log(`   Thema "${c.title}" ${fmt(c.start)} -> ${fmt(r.at)}: ${r.status}`);
    return { start: r.at, title: c.title };
  });

  log(`   Prüfung: ${good} von ${total} Marken lagen schon richtig`);
  return { adRanges: checkedAds, chapters: checkedChapters };
}

/* --------------------------------------------------------- Nachbearbeitung */

/**
 * Ein Themenanfang, der im hinteren Teil eines Werbeblocks liegt, ist das
 * sicherste Zeichen dafür, dass der Block zu lang geraten ist - dann wird
 * der Werbeblock auf den Themenanfang gekürzt. Vorher lief es umgekehrt:
 * Das Thema wurde hinter das Werbe-Ende geschoben, dadurch fehlten die
 * ersten Sätze ("Bundespräsident. Seit die Bundesversammlung am ...").
 * Weiter vorn im Block gilt es dagegen als falsch gesetztes Thema.
 */
function trimAdsByChapters(ads, chapters) {
  return ads.map(([from, to]) => {
    const length = to - from;
    const inside = chapters
      .map((c) => c.start)
      .filter((start) => start > from && start < to - 0.2)
      .filter((start) => start > to - Math.min(20, length * 0.5));
    if (inside.length === 0) return [from, to];
    const cut = Math.min(...inside);
    log(`   Werbeblock gekürzt: ${fmt(from)}-${fmt(to)} -> ${fmt(from)}-${fmt(cut)} (dort beginnt ein Thema)`);
    return [from, cut - 0.05];
  });
}

function normalizeRanges(ranges, duration) {
  const cleaned = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, duration)), Math.max(0, Math.min(b, duration))])
    .filter(([a, b]) => b - a > 1)
    .sort((x, y) => x[0] - y[0]);

  const merged = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
}

// Themen aufräumen: keins darf in einem Werbeblock beginnen, zu dicht
// beieinander liegende fallen weg, und vor dem ersten Thema steht bei
// Bedarf der Überblick vom Anfang der Sendung.
function fixChapters(chapters, adRanges, duration) {
  let firstContent = 0;
  for (const [from, to] of adRanges) {
    if (from <= firstContent + 0.5) firstContent = Math.max(firstContent, to);
    else break;
  }

  const moved = chapters
    .map((c) => {
      let start = c.start;
      for (const [from, to] of adRanges) {
        if (start >= from - 0.5 && start < to) start = to + 0.1;
      }
      return { start: Math.min(start, duration), title: c.title };
    })
    .sort((a, b) => a.start - b.start);

  const cleaned = [];
  for (const c of moved) {
    const last = cleaned[cleaned.length - 1];
    if (last && c.start - last.start < 5) continue;
    cleaned.push(c);
  }

  if (cleaned.length > 0 && cleaned[0].start > firstContent + 15) {
    cleaned.unshift({ start: firstContent, title: 'Themenüberblick' });
  }

  return cleaned.map((c) => ({ start: Math.round(c.start * 10) / 10, title: c.title }));
}

/* --------------------------------------------- Werbung herausschneiden */

/**
 * Warum überhaupt schneiden?
 *
 * Der Anbieter baut die Werbung bei jedem Abruf neu ein. Gemessen an
 * derselben Adresse: 11:49 Uhr 595 Sekunden, 11:52 Uhr 506 Sekunden (ganz
 * ohne Werbung), 11:58 Uhr 592 Sekunden - jedes Mal eine andere Datei.
 * Zeitmarken, die hier um 6 Uhr gemessen werden, passen deshalb nicht zu
 * der Datei, die das Handy um halb sieben lädt.
 *
 * Also wird die Arbeit hier zu Ende gebracht: Die Werbung wird aus der
 * analysierten Datei herausgeschnitten und genau diese Fassung abgelegt.
 * Dann stimmen die Themenmarken sekundengenau, weil Analyse und
 * Wiedergabe dieselbe Datei meinen.
 */

// Die hörbaren Stücke zwischen den Werbeblöcken.
function keepSegments(adRanges, duration) {
  const ads = adRanges
    .map(([a, b]) => [Math.max(0, a), Math.min(b, duration)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const keep = [];
  let pos = 0;
  for (const [a, b] of ads) {
    if (a > pos) keep.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (pos < duration) keep.push([pos, duration]);
  return keep.filter(([a, b]) => b - a > 0.5);
}

/**
 * Schneidet die Werbung heraus. Die Tonspur wird dabei nur umkopiert,
 * nicht neu berechnet - das dauert Sekunden und kostet keine Qualität.
 */
async function cutAds(audioPath, keep, outPath) {
  const parts = [];
  try {
    for (let i = 0; i < keep.length; i++) {
      const [from, to] = keep[i];
      const part = join(tmpdir(), `teil-${process.pid}-${i}.mp3`);
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', from.toFixed(3),
        '-t', (to - from).toFixed(3),
        '-i', audioPath,
        '-c', 'copy',
        part
      ]);
      parts.push(part);
    }

    if (parts.length === 1) {
      await copyFile(parts[0], outPath);
    } else {
      const listPath = join(tmpdir(), `liste-${process.pid}.txt`);
      await writeFile(listPath, parts.map((f) => `file '${f}'`).join('\n') + '\n');
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy',
        outPath
      ]);
      await unlink(listPath).catch(() => {});
    }
  } finally {
    for (const f of parts) await unlink(f).catch(() => {});
  }
}

// Die Themenmarken gelten für die Originaldatei. In der geschnittenen
// Fassung liegt jedes Thema um die Werbung früher, die davor lag.
function shiftChapters(chapters, adRanges, duration) {
  const ads = adRanges
    .map(([a, b]) => [Math.max(0, a), Math.min(b, duration)])
    .filter(([a, b]) => b > a);
  const entferntVor = (t) => ads
    .filter(([, b]) => b <= t)
    .reduce((summe, [a, b]) => summe + (b - a), 0);
  return chapters
    .filter((c) => !ads.some(([a, b]) => c.start >= a && c.start < b))
    .map((c) => ({ start: Math.max(0, +(c.start - entferntVor(c.start)).toFixed(2)), title: c.title }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Legt die geschnittene Datei als Anhang einer GitHub-Veröffentlichung ab
 * und liefert ihre Adresse zurück. Ohne GitHub (etwa beim Ausprobieren auf
 * dem eigenen Rechner) passiert nichts und es bleibt bei der Originaldatei.
 */
async function publishAudio(filePath, name) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GH_TOKEN) {
    log('   (keine GitHub-Umgebung - geschnittene Datei wird nicht abgelegt)');
    return null;
  }
  try {
    await run('gh', ['release', 'view', RELEASE_TAG, '--repo', repo]);
  } catch {
    await run('gh', [
      'release', 'create', RELEASE_TAG,
      '--repo', repo,
      '--title', 'Werbefrei geschnittene Folgen',
      '--notes', 'Wird von der Action gefüllt. Ältere Folgen werden automatisch gelöscht.'
    ]);
    log(`   Veröffentlichung "${RELEASE_TAG}" angelegt`);
  }
  // gh benennt den Anhang nach der Datei - sie heisst deshalb schon richtig.
  await run('gh', ['release', 'upload', RELEASE_TAG, filePath, '--clobber', '--repo', repo]);
  return `https://github.com/${repo}/releases/download/${RELEASE_TAG}/${name}`;
}

// Anhänge löschen, die zu keiner behaltenen Folge mehr gehören.
async function pruneAudio(behalteNamen) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GH_TOKEN) return;
  let assets = [];
  try {
    const { stdout } = await run('gh', ['release', 'view', RELEASE_TAG, '--repo', repo, '--json', 'assets']);
    assets = JSON.parse(stdout).assets || [];
  } catch {
    return;
  }
  for (const a of assets) {
    if (behalteNamen.has(a.name)) continue;
    try {
      await run('gh', ['release', 'delete-asset', RELEASE_TAG, a.name, '--yes', '--repo', repo]);
      log(`   alte Tondatei gelöscht: ${a.name}`);
    } catch (err) {
      log(`   konnte ${a.name} nicht löschen: ${err.message}`);
    }
  }
}

/* ----------------------------------------------------------- Hauptprogramm */

async function analyzeEpisode(ep, podcastName, structure, endMarker, expectOpeningAd) {
  log(`\n-> ${ep.title}`);
  if (ep.pubDate) log(`   erschienen: ${ep.pubDate}`);
  log(`   ${ep.audioUrl}`);

  const audioRes = await fetch(ep.audioUrl, { redirect: 'follow' });
  if (!audioRes.ok) throw new Error(`Audio HTTP ${audioRes.status}`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const sizeMb = buffer.length / (1024 * 1024);
  log(`   Audio: ${sizeMb.toFixed(1)} MB`);
  if (sizeMb > MAX_AUDIO_MB) throw new Error(`Audio zu gross (${sizeMb.toFixed(0)} MB)`);

  // Datei kurz ablegen, damit ffmpeg die Pausen messen kann
  const audioPath = join(tmpdir(), `episode-${Date.now()}.mp3`);
  await writeFile(audioPath, buffer);
  const silences = await detectSilences(audioPath);
  const fileDuration = await probeDuration(audioPath);
  log(`   Pausen gemessen: ${silences.length}`);
  log(`   Dateilänge gemessen: ${fileDuration ? fmt(fileDuration) : 'nicht messbar'}`);

  const base64 = buffer.toString('base64');

  let model = await pickSttModel();
  let lines = [];
  let words = [];
  let source = '';

  try {
    ({ lines, words, source } = await transcribe(base64, model));
  } catch (err) {
    log(`   ${model} schlug fehl: ${err.message}`);
  }

  if (lines.length === 0 && model !== STT_FALLBACK) {
    log(`   Keine brauchbaren Zeitstempel - zweiter Versuch mit ${STT_FALLBACK}`);
    sttModelCache = STT_FALLBACK;
    model = STT_FALLBACK;
    ({ lines, words, source } = await transcribe(base64, model));
  }
  if (lines.length === 0) throw new Error('Transkription ohne Zeitstempel');
  log(`   Transkript: ${lines.length} Zeilen (aus ${source}, ${model})`);

  // Die Längenangabe im Feed ist nicht verlässlich (beim Handelsblatt rund
  // 1,5 Minuten zu kurz, weil die Werbung dort nicht mitgezählt wird).
  // Es gilt die mit ffprobe gemessene Länge; nur wenn die Messung
  // fehlschlägt, zählen Feed und Transkript.
  const feedDuration = ep.durationSeconds || 0;
  const transcriptEnd = lines[lines.length - 1].end;
  const duration = fileDuration || Math.max(feedDuration, transcriptEnd);
  if (fileDuration && transcriptEnd > fileDuration + 2) {
    log(`   Hinweis: Transkript endet bei ${fmt(transcriptEnd)}, die Datei aber schon bei ${fmt(fileDuration)}`);
  }

  if (DEBUG) {
    log('   --- Transkript ---');
    lines.forEach((l, i) => log(`   [${i}] ${fmt(l.start)}-${fmt(l.end)} ${l.text}`));
    log('   --- Ende Transkript ---');
  }
  log(`   Transkript deckt ${fmt(lines[0].start)} bis ${fmt(transcriptEnd)} ab`);
  if (feedDuration && Math.abs(feedDuration - transcriptEnd) > 20) {
    log(`   Hinweis: Feed meldet ${fmt(feedDuration)}, Transkript endet bei ${fmt(transcriptEnd)} - es gilt das Transkript`);
  }
  // Zwei Wege: Mit gemessenen Pausen wird die Folge in Abschnitte zerlegt
  // und das Modell ordnet nur noch zu (genau, weil die Zeiten gemessen
  // sind). Ohne Pausen-Messung bleibt der alte Weg über die Wort-Zeiten.
  let found;
  if (silences.length > 0) {
    const blocks = buildBlocks(words, silences, duration);
    log(`   Abschnitte aus Pausen: ${blocks.length}`);
    if (DEBUG) blocks.forEach((b, i) => log(`   [${i}] ${fmt(b.start)}-${fmt(b.end)} ${b.text.slice(0, 110)}`));
    found = await findAdsAndChaptersFromBlocks(blocks, structure, endMarker, duration);
  } else {
    log('   !!! KEINE PAUSEN MESSBAR - Rückfall auf die ungenauen Wort-Zeiten !!!');
    log('   (ist ffmpeg im Workflow installiert?)');
    found = await findAdsAndChapters(lines, words, structure, endMarker);
    found.ads = trimAdsByChapters(
      found.ads.map(([from, to]) => {
        const a = snapToSilence(silences, from, 'adStart');
        const b = snapToSilence(silences, to, 'contentStart');
        return [Math.max(0, a.at), b.at];
      }),
      found.chapters
    );
  }

  let adRanges = normalizeRanges(found.ads, duration);

  // Reicht der letzte Werbeblock bis ans Ende des Transkripts, wird er
  // bewusst "offen" bis weit hinter das Dateiende gesetzt. Grund: Whisper
  // lässt die letzten Sekunden manchmal weg, und der Player begrenzt den
  // Bereich ohnehin auf die echte Dateilänge. Sonst liefe am Schluss noch
  // ein Rest Werbung.
  if (adRanges.length > 0) {
    const last = adRanges[adRanges.length - 1];
    if (last[1] >= duration - 15) {
      last[1] = 999999;
      log(`   Schlussblock läuft bis Dateiende (ab ${fmt(last[0])})`);
    }
  }
  const adSeconds = adRanges.reduce((sum, [a, b]) => sum + (Math.min(b, duration) - a), 0);
  if (duration - adSeconds < MIN_CONTENT_SECONDS) {
    throw new Error(`verworfen - nur ${Math.round(duration - adSeconds)} Sek. Inhalt übrig`);
  }

  // Sicherung gegen kaputte Zeitachsen: Wenn für diesen Podcast ein
  // Werbeblock am Anfang bekannt ist, muss einer gefunden worden sein.
  // Sonst würde die Folge mit Werbung starten - genau das, was nicht
  // passieren soll. Dann lieber keine Analyse und die festen Werte.
  // Ausnahme: Ist die Datei nur so lang, wie der Feed es angibt, wurde die
  // Fassung ohne Werbung ausgeliefert. Dann ist "keine Werbung gefunden"
  // die richtige Antwort und kein Fehler.
  const werbefrei = feedDuration > 0 && duration <= feedDuration + 10;
  if (expectOpeningAd && !werbefrei) {
    const hasOpeningAd = adRanges.some(([a]) => a < 180);
    if (!hasOpeningAd) {
      throw new Error('verworfen - kein Werbeblock am Anfang gefunden (Zeitachse unplausibel)');
    }
  }
  if (werbefrei) log('   Diese Auslieferung enthält keine Werbung (Länge = Feed-Angabe)');

  let chapters = fixChapters(found.chapters, adRanges, duration);

  // Letzter Schritt: alle Marken an der echten Datei gegenprüfen.
  const aligned = alignMarksToPauses(adRanges, chapters, silences, duration);
  adRanges = normalizeRanges(aligned.adRanges, duration);
  chapters = aligned.chapters;

  // Das offene Ende des Schlussblocks nach dem Normalisieren wiederherstellen
  if (adRanges.length > 0 && adRanges[adRanges.length - 1][1] >= duration - 1) {
    adRanges[adRanges.length - 1][1] = 999999;
  }

  log('   Werbung:');
  if (adRanges.length === 0) log('     (keine gefunden)');
  adRanges.forEach(([a, b]) => {
    const shown = Math.min(b, duration);
    log(`     ${fmt(a)} - ${fmt(shown)}${b > duration ? ' (bis Dateiende)' : ''}  (${Math.round(shown - a)} Sek.)`);
    // Die Zeilen rund um die Grenzen mitschreiben: daran sieht man sofort,
    // ob der Block zu früh endet und was danach gesprochen wird.
    const after = lines.filter((l) => l.start >= b - 0.5).slice(0, 2);
    const before = lines.filter((l) => l.end <= a + 0.5).slice(-1);
    before.forEach((l) => log(`       davor  ${fmt(l.start)}: ${l.text.slice(0, 90)}`));
    after.forEach((l) => log(`       danach ${fmt(l.start)}: ${l.text.slice(0, 90)}`));
  });
  log('   Themen:');
  chapters.forEach((c) => log(`     ${fmt(c.start)}  ${c.title}`));

  // Jetzt die Werbung wirklich herausschneiden und die fertige Fassung
  // ablegen. Scheitert das, bleibt es bei der Originaldatei und den
  // Marken - die App kommt mit beidem zurecht.
  let clean = null;
  const cleanPath = join(tmpdir(), `${ep.guid}.mp3`);
  try {
    const keep = keepSegments(adRanges, duration);
    const werbeZeit = Math.round(duration - keep.reduce((sum, [a, b]) => sum + (b - a), 0));
    await cutAds(audioPath, keep, cleanPath);
    const cleanDuration = await probeDuration(cleanPath);
    log(`   Geschnitten: ${fmt(duration)} -> ${fmt(cleanDuration)} (${werbeZeit} Sek. Werbung entfernt)`);
    const url = await publishAudio(cleanPath, `${ep.guid}.mp3`);
    if (url) {
      clean = {
        url,
        file: `${ep.guid}.mp3`,
        durationSeconds: Math.round(cleanDuration),
        chapters: shiftChapters(chapters, adRanges, duration)
      };
      log(`   Abgelegt: ${url}`);
      log('   Themen in der geschnittenen Fassung:');
      clean.chapters.forEach((c) => log(`     ${fmt(c.start)}  ${c.title}`));
    }
  } catch (err) {
    log(`   Schneiden fehlgeschlagen: ${err.message} - es bleibt bei der Originaldatei`);
  } finally {
    await unlink(cleanPath).catch(() => {});
    await unlink(audioPath).catch(() => {});
  }

  return {
    podcast: podcastName,
    title: ep.title,
    pubDate: ep.pubDate || null,
    audioUrl: ep.audioUrl, // damit sich jede Analyse von Hand nachhören lässt
    clean,
    // Länge der analysierten Datei und die Angabe aus dem Feed. Podigee
    // schaltet Werbung dynamisch dazu: dieselbe Adresse lieferte einmal
    // 10:06 (mit Werbung) und einmal 8:26 (ohne). Mit beiden Werten kann
    // die App erkennen, WELCHE Fassung sie gerade abspielt.
    feedDurationSeconds: ep.durationSeconds || null,
    adRanges,
    chapters,
    durationSeconds: Math.round(duration),
    model,
    detectedAt: new Date().toISOString()
  };
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const store = existsSync(OUT_PATH) ? JSON.parse(await readFile(OUT_PATH, 'utf8')) : {};
  const episodesStore = store.episodes || {};
  let changed = false;

  for (const podcast of config.podcasts) {
    log(`\n=== ${podcast.name} ===`);
    let episodes;
    try {
      episodes = await fetchEpisodes(podcast.feed);
    } catch (err) {
      log(`   Feed nicht ladbar: ${err.message}`);
      continue;
    }

    const maxAgeHours = podcast.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;

    const count = Number.isFinite(EPISODES_OVERRIDE) && EPISODES_OVERRIDE > 0
      ? EPISODES_OVERRIDE
      : (podcast.episodes || 1);

    for (const ep of episodes.slice(0, count)) {
      if (episodesStore[ep.guid] && !FORCE) {
        log(`   schon analysiert: ${ep.title}`);
        continue;
      }

      // Ist die neueste Folge von gestern oder älter, gibt es heute nichts
      // zu tun. Der Lauf kostet dann nur den Feed-Abruf.
      const ageHours = Number.isFinite(ep.pubDateMs)
        ? (Date.now() - ep.pubDateMs) / 3600000
        : null;
      if (!FORCE && ageHours !== null && ageHours > maxAgeHours) {
        log(`   keine neue Folge (neueste ist ${ageHours.toFixed(1)} Std. alt: ${ep.title})`);
        continue;
      }
      try {
        episodesStore[ep.guid] = await analyzeEpisode(ep, podcast.name, podcast.structure || '', podcast.endMarker || '', podcast.expectOpeningAd !== false);
        changed = true;
      } catch (err) {
        log(`   FEHLER: ${err.message}`);
      }
    }
  }

  if (!changed) {
    log('\nNichts Neues zu analysieren.');
    return;
  }

  // Nur die zuletzt analysierten Folgen behalten
  const keys = Object.keys(episodesStore)
    .sort((a, b) => String(episodesStore[b].detectedAt).localeCompare(String(episodesStore[a].detectedAt)))
    .slice(0, KEEP_EPISODES);
  const kept = {};
  for (const k of keys) kept[k] = episodesStore[k];

  // Von jedem Podcast behält nur die neueste Folge ihre Tondatei. Alle
  // anderen Anhänge werden gelöscht - gehört wird nur die Ausgabe des Tages,
  // und so bleibt bei GitHub nicht mehr liegen als nötig.
  const proPodcast = new Map();
  for (const k of keys) {
    const name = kept[k].podcast || '?';
    if (!proPodcast.has(name)) proPodcast.set(name, []);
    proPodcast.get(name).push(k);
  }
  const behalten = new Set();
  for (const [, episodenKeys] of proPodcast) {
    // keys ist schon nach Analysezeitpunkt sortiert, neueste zuerst
    episodenKeys.slice(0, KEEP_AUDIO_PER_PODCAST).forEach((k) => {
      if (kept[k].clean && kept[k].clean.file) behalten.add(kept[k].clean.file);
    });
    episodenKeys.slice(KEEP_AUDIO_PER_PODCAST).forEach((k) => {
      if (kept[k].clean) kept[k] = { ...kept[k], clean: null };
    });
  }
  await pruneAudio(behalten);

  await writeFile(OUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), episodes: kept }, null, 2) + '\n');
  log(`\nGespeichert: ${OUT_PATH} (${keys.length} Folgen)`);
}

main().catch((err) => {
  console.error('Abbruch:', err);
  process.exit(1);
});
