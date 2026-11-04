/**
 * Transcrição de áudios do WhatsApp e de vídeos por link (YouTube, X,
 * Instagram e tudo mais que o yt-dlp suporta).
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { writeFile, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcritor, MODELO_TRANSCRICAO } from './openai.js';
import { audioParaTranscricao, comPastaTemporaria, ffmpegPath } from './midia.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Vídeos mais longos estouram os 5 minutos de uma função na Vercel grátis.
const DURACAO_MAXIMA_S = 2 * 60 * 60;
const TIMEOUT_DOWNLOAD_MS = 150_000;

function ytdlpPath() {
  return process.env.YTDLP_PATH ||
    path.join(RAIZ, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

/**
 * @param {string} [idioma]  ISO-639-1. Em áudio curto o Whisper erra o idioma
 *        com frequência e a transcrição inteira sai torta; quando se sabe o
 *        idioma, informar resolve.
 */
async function transcreverPartes(partes, idioma) {
  // Em paralelo: um vídeo de 1h vira 3 pedaços, e esperar um por um come o
  // tempo da função.
  const textos = await Promise.all(partes.map(async (p) => {
    const r = await transcritor().audio.transcriptions.create({
      file: createReadStream(p),
      model: MODELO_TRANSCRICAO(),
      ...(idioma ? { language: idioma } : {})
    });
    return (r.text || '').trim();
  }));
  return textos.filter(Boolean).join('\n\n');
}

/**
 * Áudio recebido no WhatsApp (OGG/Opus) → texto. É o dono falando, então o
 * idioma é conhecido (TRANSCRICAO_IDIOMA, padrão português). Links não
 * recebem idioma: o vídeo pode ser em qualquer língua.
 */
export async function transcreverAudio(buffer) {
  return comPastaTemporaria(async (pasta) => {
    const origem = path.join(pasta, 'entrada');
    await writeFile(origem, buffer);
    const saida = path.join(pasta, 'partes');
    await mkdir(saida);
    return transcreverPartes(
      await audioParaTranscricao(origem, saida),
      process.env.TRANSCRICAO_IDIOMA ?? 'pt'
    );
  });
}

function rodarYtdlp(args, pasta) {
  return new Promise((resolve, reject) => {
    const p = spawn(ytdlpPath(), args, {
      // O executável standalone se descompacta em TMPDIR; na Vercel só /tmp é gravável.
      env: { ...process.env, TMPDIR: os.tmpdir(), HOME: pasta }
    });
    let saida = '';
    let erro = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_DOWNLOAD_MS);
    p.stdout.on('data', d => { saida += d; });
    p.stderr.on('data', d => { erro += d; });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT'
        ? new Error('yt-dlp não está instalado neste servidor (falhou o download no build)')
        : e);
    });
    p.on('close', (code, sinal) => {
      clearTimeout(timer);
      if (sinal) return reject(new Error('o download demorou demais e foi interrompido'));
      if (code !== 0) return reject(new Error(explicarErroYtdlp(erro)));
      resolve(saida.trim());
    });
  });
}

/** Traduz os erros mais comuns do yt-dlp para algo que dá para agir. */
export function explicarErroYtdlp(stderr) {
  const e = String(stderr);
  if (/sign in to confirm|login required|rate-limit|cookies/i.test(e)) {
    return 'o site bloqueou o download vindo do servidor e exige login. ' +
           'Configure a variável YTDLP_COOKIES com os cookies de uma conta (veja o README).';
  }
  if (/private|not available|removed|404/i.test(e)) return 'o vídeo é privado, foi removido ou não existe.';
  if (/unsupported url/i.test(e)) return 'esse site não é suportado.';
  const ultima = e.trim().split('\n').filter(l => /ERROR/.test(l)).pop();
  return ultima ? ultima.replace(/^ERROR:\s*/, '') : 'falha desconhecida no yt-dlp';
}

/**
 * Baixa só o áudio de um vídeo e transcreve.
 * @returns {Promise<{titulo: string, texto: string}>}
 */
export async function transcreverLink(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('link inválido');

  return comPastaTemporaria(async (pasta) => {
    const args = [
      '--no-playlist', '--no-progress', '--no-warnings',
      '-f', 'bestaudio/best',
      // "<=?" deixa passar quem não informa duração (comum em X e Instagram).
      '--match-filter', `duration <=? ${DURACAO_MAXIMA_S}`,
      '--max-filesize', '300M',
      '--ffmpeg-location', ffmpegPath(),
      // O YouTube exige rodar um desafio em JavaScript; o Node desta própria
      // função serve de runtime.
      '--js-runtimes', `node:${process.execPath}`,
      '--cache-dir', path.join(pasta, 'cache'),
      '--no-simulate', '--print', 'title',
      '-o', path.join(pasta, 'midia.%(ext)s')
    ];

    if (process.env.YTDLP_COOKIES) {
      const cookies = path.join(pasta, 'cookies.txt');
      await writeFile(cookies, process.env.YTDLP_COOKIES);
      args.push('--cookies', cookies);
    }

    // "--" impede que um link começando com "-" vire opção do yt-dlp.
    const titulo = await rodarYtdlp([...args, '--', url], pasta);

    const baixado = (await readdir(pasta)).find(n => n.startsWith('midia.'));
    if (!baixado) {
      throw new Error(`o vídeo passa de ${DURACAO_MAXIMA_S / 3600}h ou não tem áudio para baixar.`);
    }

    const partes = path.join(pasta, 'partes');
    await mkdir(partes);
    const texto = await transcreverPartes(
      await audioParaTranscricao(path.join(pasta, baixado), partes)
    );

    return { titulo: titulo.split('\n')[0] || '', texto };
  });
}
