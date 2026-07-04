// Generates small placeholder WAV tones so the announcement/composition pipeline (spec 11) is
// demoable end-to-end without real recorded Malayalam audio. Pure Node, no ffmpeg/dependency —
// replace these files with real recordings via the Admin Dashboard's Stop Audio Management
// (Phase 2) when they exist; the Hub doesn't care how a .wav file at content_items.file_path
// was produced.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'audio');
const SAMPLE_RATE = 22050;

function writeWav(filePath, freqHz, durationSec) {
  const numSamples = Math.floor(SAMPLE_RATE * durationSec);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.min(numSamples / 4, SAMPLE_RATE * 0.02);
  for (let i = 0; i < numSamples; i++) {
    let amplitude = 0.5;
    if (i < fadeSamples) amplitude *= i / fadeSamples;
    if (i > numSamples - fadeSamples) amplitude *= (numSamples - i) / fadeSamples;
    const sample = Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * amplitude * 32767;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
  console.log(`[gen-audio] wrote ${filePath}`);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

writeWav(path.join(OUT_DIR, 'chime.wav'), 880, 0.6);
writeWav(path.join(OUT_DIR, 'filler.wav'), 550, 0.8); // common phrase, shared by every announcement
writeWav(path.join(OUT_DIR, 'outro.wav'), 440, 0.5);
writeWav(path.join(OUT_DIR, 'sponsor-demo.wav'), 660, 1.2); // legacy asset, kept for old sponsor_snippet rows

const stopIds = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
stopIds.forEach((id, i) => {
  writeWav(path.join(OUT_DIR, `stopname-${id}.wav`), 300 + i * 40, 0.9);
});

writeWav(path.join(OUT_DIR, 'stopname-ad-S3.wav'), 500, 1.6); // stop name + sponsor line, combined (ads swap demo)

console.log('[gen-audio] done — these are audible placeholder tones, not real announcements.');
