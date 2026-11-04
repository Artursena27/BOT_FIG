import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import {
  ffmpeg, comPastaTemporaria, figurinhaDeImagem, figurinhaDeVideo, gifDeVideo, audioParaTranscricao
} from '../lib/midia.js';

/** Vídeo de teste gerado pelo próprio ffmpeg (barras coloridas + bipe). */
async function videoDeTeste(segundos = 4) {
  return comPastaTemporaria(async (pasta) => {
    const destino = path.join(pasta, 'v.mp4');
    await ffmpeg([
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30:duration=${segundos}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', destino
    ]);
    return readFile(destino);
  });
}

test('foto vira figurinha estática 512x512 dentro do limite', async () => {
  const foto = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 40, b: 90 } }
  }).jpeg().toBuffer();

  const { webp, animada } = await figurinhaDeImagem(foto);
  const meta = await sharp(webp).metadata();
  assert.equal(animada, false);
  assert.equal(meta.format, 'webp');
  assert.deepEqual([meta.width, meta.height], [512, 512]);
  assert.ok(webp.length <= 100 * 1024);
});

test('vídeo vira figurinha animada 512x512 com até 500KB', async () => {
  const { webp, animada } = await figurinhaDeVideo(await videoDeTeste(), { duracao: 3 });
  const meta = await sharp(webp, { animated: true }).metadata();
  assert.equal(animada, true);
  assert.equal(meta.format, 'webp');
  assert.ok(meta.pages > 10, `quadros: ${meta.pages}`);
  assert.equal(meta.width, 512);
  assert.equal(meta.pageHeight, 512);
  assert.ok(webp.length <= 500 * 1024, `${webp.length} bytes`);
});

test('vídeo vira GIF (MP4 mudo e curto)', async () => {
  const mp4 = await gifDeVideo(await videoDeTeste(4), { inicio: 1, duracao: 2 });
  assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
  assert.ok(mp4.length > 1000);
});

test('áudio é convertido em MP3 mono para a transcrição', async () => {
  const video = await videoDeTeste(3);
  await comPastaTemporaria(async (pasta) => {
    const origem = path.join(pasta, 'entrada');
    await (await import('node:fs/promises')).writeFile(origem, video);
    const partes = await audioParaTranscricao(origem, pasta);
    assert.equal(partes.length, 1);
    assert.match(partes[0], /parte000\.mp3$/);
    assert.ok((await stat(partes[0])).size > 1024);
  });
});
