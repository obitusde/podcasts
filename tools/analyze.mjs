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
const STT_MODEL = 'openai/whisper-large-v3-turbo'; // ca. 0,2 Cent je 10 Min. Audio
const STT_FALLBACK = 'openai/whisper-large-v3';    // falls keine Zeitstempel kommen
const TEXT_MODEL = 'google/gemini-3.1-flash-lite'; // findet Werbung/Themen im Text

const CONFIG_PATH = 'tools/podcasts.config.json';
const OUT_PATH = 'data/analysis.json';

const KEEP_EPISODES = 60;      // so viele Analysen bleiben in der Datei
const MAX_AUDIO_MB = 60;
const MIN_CONTENT_SECONDS = 120; // Plausibilität: so viel Inhalt muss übrig bleiben
const LINE_MAX_SECONDS = 8;      // Länge der Transkript-Zeilen fürs Textmodell
const LINE_MAX_WORDS = 22;
const PAD_BEFORE = 0.3;          // Werbeblock minimal weiter fassen
const PAD_AFTER = 0.4;

// FORCE=1 analysiert auch Folgen neu, die schon im Ergebnis stehen -
// nützlich, wenn Prompt oder Modell geändert wurden.
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';

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
    episodes.push({
      guid: tagText(item, 'guid') || enclosure[1],
      title: tagText(item, 'title') || '(ohne Titel)',
      audioUrl: enclosure[1],
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
    if (lines.length > 0) return { lines, source: `${words.length} Wörter` };
  }

  const lines = segments
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: (s.text || '').trim() }))
    .filter((s) => Number.isFinite(s.start) && s.text);
  return { lines, source: `${segments.length} Abschnitte` };
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
    'KEINE Werbung sind: die Vorstellung der Themen am Anfang, Begrüssung und Verabschiedung des Moderators sowie normale journalistische Berichte über Firmen.',
    'Setze die Grenzen so eng wie möglich: die erste Zeile des Blocks ist die erste Werbezeile, die letzte Zeile die letzte - die darauffolgende Zeile muss wieder redaktioneller Inhalt sein.',
    '',
    'Aufgabe 2 - Themen: Gliedere den redaktionellen Teil in 3 bis 12 Themen. Gib für jedes Thema die Zeilennummer an, bei der es beginnt, und einen kurzen deutschen Titel (höchstens 40 Zeichen, keine Anführungszeichen). Ein Thema darf NIE in einem Werbeblock beginnen. Die Themenvorstellung am Anfang ist kein eigenes Thema. Gibt es einen Sport-, Wetter- oder Boulevardblock, soll er ein eigenes Thema mit passendem Titel sein.',
    '',
    'Antworte AUSSCHLIESSLICH mit diesem JSON, ohne Markdown und ohne weiteren Text:',
    '{"ads":[{"von":0,"bis":4}],"themen":[{"zeile":5,"titel":"Zollstreit mit China"}]}',
    '',
    'Transkript:',
    transcript
  ].join('\n');
}

async function findAdsAndChapters(lines, structure) {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [{ role: 'user', content: buildPrompt(lines, structure) }],
      temperature: 0
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Analyse HTTP ${res.status}: ${text.slice(0, 300)}`);

  const content = JSON.parse(text).choices?.[0]?.message?.content;
  if (!content) throw new Error('Keine Antwort vom Analyse-Modell');

  const parsed = JSON.parse(content.replace(/```json/gi, '').replace(/```/g, '').trim());
  log('   Antwort:', JSON.stringify(parsed));

  const ads = (parsed.ads || [])
    .map((a) => {
      const from = lines[a.von];
      const to = lines[a.bis ?? a.von];
      if (!from || !to) return null;
      return [Math.max(0, from.start - PAD_BEFORE), to.end + PAD_AFTER];
    })
    .filter(Boolean);

  const chapters = (parsed.themen || [])
    .map((c) => {
      const line = lines[c.zeile];
      if (!line || !c.titel) return null;
      return { start: Math.max(0, line.start - PAD_BEFORE), title: String(c.titel).slice(0, 60) };
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

async function analyzeEpisode(ep, structure) {
  log(`\n-> ${ep.title}`);
  log(`   ${ep.audioUrl}`);

  const audioRes = await fetch(ep.audioUrl, { redirect: 'follow' });
  if (!audioRes.ok) throw new Error(`Audio HTTP ${audioRes.status}`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const sizeMb = buffer.length / (1024 * 1024);
  log(`   Audio: ${sizeMb.toFixed(1)} MB`);
  if (sizeMb > MAX_AUDIO_MB) throw new Error(`Audio zu gross (${sizeMb.toFixed(0)} MB)`);

  const base64 = buffer.toString('base64');

  let { lines, source } = await transcribe(base64, STT_MODEL);
  let model = STT_MODEL;
  if (lines.length === 0) {
    log('   Keine Zeitstempel - zweiter Versuch mit', STT_FALLBACK);
    ({ lines, source } = await transcribe(base64, STT_FALLBACK));
    model = STT_FALLBACK;
  }
  if (lines.length === 0) throw new Error('Transkription ohne Zeitstempel');
  log(`   Transkript: ${lines.length} Zeilen (aus ${source}, ${model})`);

  // Die Längenangabe im Feed ist nicht verlässlich (beim Handelsblatt rund
  // 1,5 Minuten zu kurz). Das Transkript kennt die echte Länge - sonst
  // würde der Werbeblock am Schluss einfach abgeschnitten.
  const feedDuration = ep.durationSeconds || 0;
  const transcriptEnd = lines[lines.length - 1].end;
  const duration = Math.max(feedDuration, transcriptEnd);
  if (feedDuration && Math.abs(feedDuration - transcriptEnd) > 20) {
    log(`   Hinweis: Feed meldet ${fmt(feedDuration)}, Transkript endet bei ${fmt(transcriptEnd)} - es gilt das Transkript`);
  }
  const found = await findAdsAndChapters(lines, structure);

  const adRanges = normalizeRanges(found.ads, duration);
  const adSeconds = adRanges.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (duration - adSeconds < MIN_CONTENT_SECONDS) {
    throw new Error(`verworfen - nur ${Math.round(duration - adSeconds)} Sek. Inhalt übrig`);
  }

  const chapters = fixChapters(found.chapters, adRanges, duration);

  log('   Werbung:');
  if (adRanges.length === 0) log('     (keine gefunden)');
  adRanges.forEach(([a, b]) => log(`     ${fmt(a)} - ${fmt(b)}  (${Math.round(b - a)} Sek.)`));
  log('   Themen:');
  chapters.forEach((c) => log(`     ${fmt(c.start)}  ${c.title}`));

  return {
    title: ep.title,
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

    for (const ep of episodes.slice(0, podcast.episodes || 1)) {
      if (episodesStore[ep.guid] && !FORCE) {
        log(`   schon analysiert: ${ep.title}`);
        continue;
      }
      try {
        episodesStore[ep.guid] = await analyzeEpisode(ep, podcast.structure || '');
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
