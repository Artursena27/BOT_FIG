/**
 * Conversões de mídia: figurinhas (sharp/ffmpeg), "GIF" (MP4 mudo) e áudio
 * para transcrição.
 *
 * Na Vercel só /tmp é gravável; os arquivos intermediários vivem lá, numa
 * pasta por chamada, apagada no fim.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';

// WhatsApp sticker limits (Cloud API)
const STATIC_MAX_BYTES = 100 * 1024;
const ANIMATED_MAX_BYTES = 500 * 1024;

// Figurinha animada passa de 10s só com qualidade horrível; GIF um pouco mais.
const MAX_FIGURINHA_S = 10;
const MAX_GIF_S = 15;

export const ffmpegPath = () => process.env.FFMPEG_PATH || ffmpegStatic;

export function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let erro = '';
    p.stderr.on('data', d => { erro += d; });
    p.on('error', reject);
    p.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com ${code}: ${erro.slice(-500)}`))
    );
  });
}

/** Roda `fn(pasta)` numa pasta temporária que é apagada no fim, dê certo ou não. */
export async function comPastaTemporaria(fn) {
  const pasta = await mkdtemp(path.join(os.tmpdir(), 'agente-'));
  try {
    return await fn(pasta);
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

/**
 * Imagem (estática ou GIF animado) → figurinha WebP 512x512 com fundo
 * transparente. Vai baixando a qualidade até caber no limite.
 */
export async function figurinhaDeImagem(entrada) {
  const meta = await sharp(entrada, { animated: true }).metadata();
  const animada = (meta.pages || 1) > 1;
  const limite = animada ? ANIMATED_MAX_BYTES : STATIC_MAX_BYTES;

  let saida;
  for (const quality of [80, 60, 40, 25]) {
    saida = await sharp(entrada, { animated: true })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality, effort: 6 })
      .toBuffer();
    if (saida.length <= limite) break;
  }

  return { webp: saida, animada };
}

/**
 * Vídeo → figurinha animada (WebP 512x512, até 10s, até 500KB). Tenta com fps e
 * qualidade cada vez menores até caber.
 */
export async function figurinhaDeVideo(entrada, trecho = {}) {
  return comPastaTemporaria(async (pasta) => {
    const origem = path.join(pasta, 'entrada');
    const destino = path.join(pasta, 'figurinha.webp');
    await writeFile(origem, entrada);

    let webp;
    for (const { fps, q } of [{ fps: 15, q: 50 }, { fps: 12, q: 40 }, { fps: 10, q: 30 }, { fps: 8, q: 20 }]) {
      await ffmpeg([
        ...(trecho.inicio ? ['-ss', String(trecho.inicio)] : []),
        '-i', origem,
        '-t', String(Math.min(trecho.duracao || MAX_FIGURINHA_S, MAX_FIGURINHA_S)),
        '-an',
        '-vf', `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,format=rgba,` +
               'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        '-c:v', 'libwebp', '-lossless', '0', '-compression_level', '6',
        '-q:v', String(q), '-loop', '0',
        destino
      ]);
      webp = await readFile(destino);
      if (webp.length <= ANIMATED_MAX_BYTES) break;
    }

    return { webp, animada: true };
  });
}

/** Vídeo → "GIF": MP4 curto, mudo, até 480px de largura. */
export async function gifDeVideo(entrada, trecho = {}) {
  return comPastaTemporaria(async (pasta) => {
    const origem = path.join(pasta, 'entrada');
    const destino = path.join(pasta, 'gif.mp4');
    await writeFile(origem, entrada);

    await ffmpeg([
      ...(trecho.inicio ? ['-ss', String(trecho.inicio)] : []),
      '-i', origem,
      '-t', String(Math.min(trecho.duracao || MAX_GIF_S, MAX_GIF_S)),
      '-an',
      '-vf', "fps=20,scale='min(480,iw)':-2",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28',
      '-movflags', '+faststart',
      destino
    ]);
    return readFile(destino);
  });
}

// Pedaços de 20 min a 32kbps mono dão ~4.8MB, folgado sob o teto de 25MB da
// API de transcrição, que também não aceita o .ogg dos áudios do WhatsApp.
const SEGMENTO_S = 20 * 60;

/**
 * Converte qualquer áudio/vídeo em MP3s leves, cortados em pedaços que a API
 * de transcrição aceita. Devolve os caminhos em ordem.
 */
export async function audioParaTranscricao(origem, pasta) {
  await ffmpeg([
    '-i', origem,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(SEGMENTO_S),
    path.join(pasta, 'parte%03d.mp3')
  ]);

  const partes = (await readdir(pasta)).filter(n => /^parte\d+\.mp3$/.test(n)).sort();
  const caminhos = partes.map(n => path.join(pasta, n));

  // Segmento vazio no fim (arredondamento do ffmpeg) quebraria a transcrição.
  const tamanhos = await Promise.all(caminhos.map(c => stat(c).then(s => s.size)));
  return caminhos.filter((_, i) => tamanhos[i] > 1024);
}
