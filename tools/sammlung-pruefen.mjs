/**
 * Prüft, was die Sammlung heute enthalten würde und ob es Doppelte gibt.
 *
 * Holt die Beiträge aller Quellen mit Sammlung = ja über denselben Proxy
 * und mit denselben Adressen wie die App (index.html, loadPodcast), nimmt
 * die vom Zeitfenster der Sammlung erfassten (seit gestern 15:00 deutscher
 * Zeit) und sucht Doppelte:
 *   - gleiche guid oder gleiche Tondatei
 *   - gleicher Titel (Gross-/Kleinschreibung und Satzzeichen egal)
 *   - ähnlicher Titel (Wortüberschneidung), vor allem zwischen Quellen
 *
 * Aufruf: node tools/sammlung-pruefen.mjs
 */
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const PROXY = /const PROXY_URL = "([^"]+)"/.exec(html)[1];
const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const quellen = config.podcasts.filter((p) => p.sammlung);

// "seit": gestern 15:00 deutsche Zeit (wie sammlungSlot in index.html)
const jetzt = new Date();
const berlinJetzt = new Date(jetzt.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
const versatz = berlinJetzt.getTime() - jetzt.getTime();          // Wandzeit minus echte Zeit
const tag = new Date(berlinJetzt.getFullYear(), berlinJetzt.getMonth(), berlinJetzt.getDate());
if (berlinJetzt.getHours() < 7) tag.setDate(tag.getDate() - 1);   // vor 7 Uhr gilt noch der Vortag
const seitWand = new Date(tag.getFullYear(), tag.getMonth(), tag.getDate() - 1, 15, 0, 0);
const seit = new Date(seitWand.getTime() - versatz);
console.log(`Jetzt (Berlin): ${berlinJetzt.toLocaleString('de-DE')}   Fenster seit: ${seitWand.toLocaleString('de-DE')} (gestern 15:00)\n`);

const sekunden = (d) => {
  if (d === null || d === undefined || d === '') return null;
  const t = String(d).trim();
  if (/^\d+$/.test(t)) return Number(t);
  const p = t.split(':').map(Number);
  if (p.some(Number.isNaN)) return null;
  return p.reduce((s, x) => s * 60 + x, 0);
};
const fmt = (s) => (s === null ? '?' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const norm = (t) => String(t).toLowerCase().replace(/[^a-zäöüß0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const woerter = (t) => new Set(norm(t).split(' ').filter((w) => w.length >= 4));
const aehnlich = (a, b) => {
  const A = woerter(a), B = woerter(b);
  if (!A.size || !B.size) return 0;
  let gemeinsam = 0; A.forEach((w) => { if (B.has(w)) gemeinsam++; });
  return gemeinsam / Math.min(A.size, B.size);
};

const alle = [];
for (const q of quellen) {
  const url = q.type === 'dlf_audio' ? PROXY + '?mode=dlfaudio'
    : q.type === 'tagesschau_audio' ? PROXY + '?mode=tagesschau'
    : PROXY + '?feed=' + encodeURIComponent(q.feed) +
      (q.minDurationSeconds ? '&minDuration=' + q.minDurationSeconds : '') +
      (q.titleContains ? '&titleContains=' + encodeURIComponent(q.titleContains) : '') +
      (q.titleExcludes ? '&titleExcludes=' + encodeURIComponent(q.titleExcludes) : '');
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const j = await res.json();
    const eps = j.episodes || [];
    const imFenster = eps.filter((e) => e.pubDate && new Date(e.pubDate) >= seit);
    console.log(`${q.name}: ${eps.length} im Feed, ${imFenster.length} im Fenster${j.error ? '  FEHLER: ' + j.error : ''}`);
    imFenster.forEach((e) => alle.push({ quelle: q.name, ...e, sek: sekunden(e.duration), zeit: new Date(e.pubDate) }));
  } catch (e) { console.log(`${q.name}: FEHLER ${e.message}`); }
}

alle.sort((a, b) => a.zeit - b.zeit);
console.log(`\n=== Die Sammlung hätte ${alle.length} Beiträge (älteste zuerst) ===`);
const hm = (d) => d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
alle.forEach((e, i) => console.log(`${String(i + 1).padStart(2)}. ${hm(e.zeit)}  ${fmt(e.sek).padStart(5)}  [${e.quelle}] ${e.title}`));
console.log(`Gesamtlänge: ${fmt(alle.reduce((s, e) => s + (e.sek || 0), 0))} (Std:Min wäre ${(alle.reduce((s, e) => s + (e.sek || 0), 0) / 3600).toFixed(1)} h)`);

console.log('\n=== Doppelte ===');
let gefunden = 0;
const melde = (art, a, b, extra = '') => {
  gefunden++;
  console.log(`${art}${extra}:\n    [${a.quelle}] ${hm(a.zeit)} ${fmt(a.sek)} ${a.title}\n    [${b.quelle}] ${hm(b.zeit)} ${fmt(b.sek)} ${b.title}`);
};
for (let i = 0; i < alle.length; i++) for (let j = i + 1; j < alle.length; j++) {
  const a = alle[i], b = alle[j];
  if (a.guid === b.guid) melde('GLEICHE GUID', a, b);
  else if (a.audioUrl === b.audioUrl) melde('GLEICHE TONDATEI', a, b);
  else if (norm(a.title) === norm(b.title)) melde('GLEICHER TITEL', a, b);
  else {
    const s = aehnlich(a.title, b.title);
    if (s >= 0.6) melde('ÄHNLICHER TITEL', a, b, ` (${Math.round(s * 100)} % gemeinsame Wörter)`);
  }
}
if (!gefunden) console.log('keine');
