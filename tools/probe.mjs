/**
 * Untersucht, welche Fassung einer Folge der Anbieter ausliefert.
 *
 * Hintergrund: Podigee schaltet Werbung dynamisch zu - dieselbe Adresse
 * liefert mal die Fassung mit Werbung, mal die ohne, je nachdem welcher
 * Auslieferungsserver antwortet. Einmal gemessene Marken gelten aber nur
 * für genau eine Fassung.
 *
 * Diese Prüfung lädt die Folge mehrfach und über verschiedene Varianten
 * der Adresse herunter und zeigt, welche Längen dabei herauskommen.
 * Kommt bei einer Variante immer dieselbe (am besten die kurze, werbe-
 * freie) Länge heraus, ist das Problem damit gelöst.
 *
 * Aufruf: node tools/probe.mjs <audio-url> [runden]
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const input = process.argv[2];
const rounds = Number(process.argv[3] || 3);
if (!input) {
  console.error('Aufruf: node tools/probe.mjs <audio-url> [runden]');
  process.exit(1);
}

// Varianten der Adresse, die getestet werden.
const base = input.split('?')[0];
const variants = [
  { name: 'wie im Feed      ', url: input },
  { name: 'ohne Zusatz      ', url: base },
  { name: 'source=webplayer ', url: base + '?source=webplayer' },
  { name: 'source=website   ', url: base + '?source=website' }
];

const md5 = (buf) => createHash('md5').update(buf).digest('hex').slice(0, 10);

function duration(buf) {
  const file = `/tmp/probe-${process.pid}-${Date.now()}.mp3`;
  writeFileSync(file, buf);
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8' });
  unlinkSync(file);
  return Number(out.stdout) || 0;
}

const seen = new Map(); // Variante -> Set von Längen

for (let round = 1; round <= rounds; round++) {
  console.log(`\n--- Runde ${round} ---`);
  for (const v of variants) {
    try {
      const res = await fetch(v.url, { redirect: 'follow' });
      if (!res.ok) { console.log(`${v.name} HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const sec = duration(buf);
      const typ = res.headers.get('content-type') || '?';
      console.log(`${v.name} ${(buf.length / 1048576).toFixed(1)} MB · ${sec.toFixed(1)}s · ${md5(buf)} · ${typ}`);
      if (!seen.has(v.name)) seen.set(v.name, new Set());
      seen.get(v.name).add(Math.round(sec));
    } catch (err) {
      console.log(`${v.name} Fehler: ${err.message}`);
    }
  }
}

console.log('\n=== Ergebnis ===');
let stabil = null;
for (const [name, lengths] of seen) {
  const list = [...lengths].sort((a, b) => a - b);
  const note = list.length === 1 ? 'IMMER GLEICH' : 'schwankt';
  console.log(`${name} ${list.join(' / ')} s  ->  ${note}`);
  if (list.length === 1 && (stabil === null || list[0] < stabil.len)) {
    stabil = { name, len: list[0] };
  }
}
if (stabil) {
  console.log(`\nStabil und am kürzesten: "${stabil.name.trim()}" mit ${stabil.len}s.`);
} else {
  console.log('\nKeine Variante liefert verlässlich dieselbe Fassung.');
}
