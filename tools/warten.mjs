// Soll die Action am Morgen noch einmal in den Feed schauen?
// ---------------------------------------------------------------------------
// Warum: Die Folgen tragen eine frühe Uhrzeit (HeuteMorgen 6:00), stehen
// aber oft erst deutlich später im Feed - am 5.11. war HeuteMorgen um 7:04
// noch nicht da. Ein einzelner Lauf um 6:20 oder 7:00 geht dann ins Leere,
// und die geplanten Läufe von GitHub fallen am Morgen regelmässig aus.
// Deshalb bleibt der Morgenlauf stehen und schaut alle paar Minuten nach,
// bis jede Morgensendung ihre Folge des Tages hat - längstens bis 10:00.
//
// Gibt "warten" aus, wenn noch etwas fehlt, sonst "fertig". Den Grund
// schreibt es ins Protokoll (stderr).
//
// Eine Morgensendung ist ein Podcast, dessen zuletzt analysierte Folge
// zwischen 4 und 10 Uhr datiert ist. Gewartet wird nur Montag bis Freitag:
// Am Wochenende erscheinen die Morgensendungen nicht (Echo der Zeit am
// Sonntag früh ist eine Ausnahme, auf die nicht gewartet wird).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ZONE = 'Europe/Berlin';
const BIS_STUNDE = 10;
const MORGEN = [4, 10];   // [von, bis) in deutscher Zeit

function berlin(ms) {
  const teile = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((t) => [t.type, t.value]));
  return { tag: `${teile.year}-${teile.month}-${teile.day}`, stunde: Number(teile.hour), wochentag: teile.weekday };
}

export function entscheide({ jetztMs, stand, analyse, force = false, only = '' }) {
  if (force || only) return { warten: false, grund: 'Lauf von Hand mit Auswahl - kein Warten' };
  const jetzt = berlin(jetztMs);
  if (jetzt.wochentag === 'Sat' || jetzt.wochentag === 'Sun') return { warten: false, grund: 'Wochenende' };
  if (jetzt.stunde < MORGEN[0] || jetzt.stunde >= BIS_STUNDE) {
    return { warten: false, grund: `nicht am Morgen (${jetzt.stunde} Uhr)` };
  }

  // Neueste analysierte Folge je Podcast
  const neueste = {};
  for (const e of Object.values(analyse || {})) {
    const ms = Date.parse(e.pubDate);
    if (!e.podcastId || !Number.isFinite(ms)) continue;
    if (!neueste[e.podcastId] || ms > neueste[e.podcastId]) neueste[e.podcastId] = ms;
  }

  const fehlt = [];
  for (const [id, feed] of Object.entries((stand && stand.feeds) || {})) {
    const letzte = neueste[id];
    if (!letzte) continue;
    const s = berlin(letzte).stunde;
    if (s < MORGEN[0] || s >= MORGEN[1]) continue;   // keine Morgensendung
    if (feed.neuesteMs && berlin(feed.neuesteMs).tag === jetzt.tag) continue;   // heutige Folge ist da
    fehlt.push(feed.name || id);
  }
  if (!fehlt.length) return { warten: false, grund: 'alle Morgensendungen von heute sind da' };
  return { warten: true, grund: `noch nicht im Feed: ${fehlt.join(', ')}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const datei = process.env.STAND_DATEI || '';
  const stand = datei && existsSync(datei) ? JSON.parse(readFileSync(datei, 'utf8')) : {};
  const analyse = existsSync('data/analysis.json')
    ? (JSON.parse(readFileSync('data/analysis.json', 'utf8')).episodes || {})
    : {};
  const { warten, grund } = entscheide({
    jetztMs: Date.now(), stand, analyse,
    force: process.env.FORCE === '1' || process.env.FORCE === 'true',
    only: (process.env.ONLY || '').trim(),
  });
  console.error(`Warten? ${warten ? 'ja' : 'nein'} - ${grund}`);
  console.log(warten ? 'warten' : 'fertig');
}
