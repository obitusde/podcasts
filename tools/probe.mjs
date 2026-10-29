/**
 * Lädt dieselbe Folge mehrfach herunter und vergleicht die Dateien.
 *
 * Hintergrund: Podigee schaltet Werbung dynamisch zu - dieselbe Adresse
 * kann unterschiedlich lange Dateien liefern. Diese Prüfung beantwortet
 * die entscheidende Frage: Verschiebt sich dabei auch der redaktionelle
 * Inhalt, oder bleibt der Anfang Byte für Byte derselbe und nur das Ende
 * ändert sich? Davon hängt ab, ob die einmal gemessenen Marken für jede
 * Auslieferung gelten.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const url = process.argv[2];
const runs = Number(process.argv[3] || 3);
if (!url) {
  console.error('Aufruf: node tools/probe.mjs <audio-url> [anzahl]');
  process.exit(1);
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex').slice(0, 12);

function duration(buf) {
  const file = '/tmp/probe-' + Date.now() + '.mp3';
  writeFileSync(file, buf);
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8' });
  unlinkSync(file);
  return Number(out.stdout) || 0;
}

const results = [];
for (let i = 1; i <= runs; i++) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const r = {
    bytes: buf.length,
    seconds: duration(buf),
    ganz: md5(buf),
    erste2MB: md5(buf.subarray(0, 2 * 1024 * 1024)),
    letzte2MB: md5(buf.subarray(-2 * 1024 * 1024))
  };
  results.push(r);
  console.log(`Lauf ${i}: ${r.bytes} Bytes · ${r.seconds.toFixed(1)}s · ganz ${r.ganz} · Anfang ${r.erste2MB} · Ende ${r.letzte2MB}`);
}

const gleicherAnfang = results.every((r) => r.erste2MB === results[0].erste2MB);
const gleicheDatei = results.every((r) => r.ganz === results[0].ganz);
const laengen = [...new Set(results.map((r) => Math.round(r.seconds)))];

console.log('\n--- Ergebnis ---');
console.log('Längen:', laengen.join(' / '), 'Sekunden');
if (gleicheDatei) {
  console.log('IDENTISCH: Jede Auslieferung ist dieselbe Datei. Marken gelten immer.');
} else if (gleicherAnfang) {
  console.log('ANFANG GLEICH: Nur das Ende unterscheidet sich.');
  console.log('-> Inhalt und Werbung am Anfang liegen fest, nur die Schlusswerbung variiert.');
  console.log('-> Die Marken gelten, die Längenprüfung im Player darf lockerer sein.');
} else {
  console.log('ANFANG VERSCHIEDEN: Die Werbung vorn ist je Auslieferung anders lang.');
  console.log('-> Die Zeitachse verschiebt sich, feste Marken reichen nicht.');
}
