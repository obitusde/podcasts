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

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const API = 'https://openrouter.ai/api/v1';
// Transkriptionsmodell. Entscheidend ist nicht die Worterkennung - die war
// bei allen gut -, sondern die Genauigkeit der Zeitstempel rund um Musik:
// Whisper-Turbo setzte dasselbe Wort in drei Läufen auf 1:29, 1:34 und
// 1:37. Deshalb zuerst das genauere Modell, Whisper bleibt Rückfallebene.
// Das erste aus dieser Liste, das es bei OpenRouter gibt, wird genommen.
const STT_PREFERENCE = [
  'microsoft/mai-transcribe-2',      // ca. 1,7 Cent je 10 Min., Wort-Zeitstempel
  'openai/whisper-large-v3',         // ca. 0,5 Cent
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
// Nur frische Folgen werden analysiert: Ist die neueste Folge älter als
// das hier, gibt es heute keine neue Ausgabe (Wochenende, Feiertag) und
// der Lauf endet sofort wieder - ohne Kosten.
const DEFAULT_MAX_AGE_HOURS = 14;
const MAX_AUDIO_MB = 60;
const MIN_CONTENT_SECONDS = 120; // Plausibilität: so viel Inhalt muss übrig bleiben
const LINE_MAX_SECONDS = 8;      // Länge der Transkript-Zeilen fürs Textmodell
const LINE_MAX_WORDS = 22;
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
      const start = wordStart !== null ? wordStart : line.start;
      if (wordStart !== null && Math.abs(wordStart - line.start) > 0.6) {
        log(`   Thema "${c.titel}": ${fmt(line.start)} (Zeile) -> ${fmt(wordStart)} (erstes Wort)`);
      }
      return { start: Math.max(0, start - PAD_BEFORE), title: String(c.titel).slice(0, 60) };
    })
    .filter(Boolean);

  return { ads, chapters };
}

/* --------------------------------------------------------- Nachbearbeitung */

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

/* ----------------------------------------------------------- Hauptprogramm */

async function analyzeEpisode(ep, structure, endMarker) {
  log(`\n-> ${ep.title}`);
  if (ep.pubDate) log(`   erschienen: ${ep.pubDate}`);
  log(`   ${ep.audioUrl}`);

  const audioRes = await fetch(ep.audioUrl, { redirect: 'follow' });
  if (!audioRes.ok) throw new Error(`Audio HTTP ${audioRes.status}`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const sizeMb = buffer.length / (1024 * 1024);
  log(`   Audio: ${sizeMb.toFixed(1)} MB`);
  if (sizeMb > MAX_AUDIO_MB) throw new Error(`Audio zu gross (${sizeMb.toFixed(0)} MB)`);

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
  // 1,5 Minuten zu kurz). Das Transkript kennt die echte Länge - sonst
  // würde der Werbeblock am Schluss einfach abgeschnitten.
  const feedDuration = ep.durationSeconds || 0;
  const transcriptEnd = lines[lines.length - 1].end;
  const duration = Math.max(feedDuration, transcriptEnd);

  if (DEBUG) {
    log('   --- Transkript ---');
    lines.forEach((l, i) => log(`   [${i}] ${fmt(l.start)}-${fmt(l.end)} ${l.text}`));
    log('   --- Ende Transkript ---');
  }
  if (feedDuration && Math.abs(feedDuration - transcriptEnd) > 20) {
    log(`   Hinweis: Feed meldet ${fmt(feedDuration)}, Transkript endet bei ${fmt(transcriptEnd)} - es gilt das Transkript`);
  }
  const found = await findAdsAndChapters(lines, words, structure, endMarker);

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

  const chapters = fixChapters(found.chapters, adRanges, duration);

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

  return {
    title: ep.title,
    pubDate: ep.pubDate || null,
    audioUrl: ep.audioUrl, // damit sich jede Analyse von Hand nachhören lässt
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
        episodesStore[ep.guid] = await analyzeEpisode(ep, podcast.structure || '', podcast.endMarker || '');
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

  await writeFile(OUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), episodes: kept }, null, 2) + '\n');
  log(`\nGespeichert: ${OUT_PATH} (${keys.length} Folgen)`);
}

main().catch((err) => {
  console.error('Abbruch:', err);
  process.exit(1);
});
