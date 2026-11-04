/**
 * Baixa o executável standalone do yt-dlp para bin/ (roda no postinstall).
 *
 * A versão standalone já traz o Python dentro, então funciona na Vercel, onde
 * não há Python instalado. Na Vercel o build roda em Linux x64, que é o mesmo
 * ambiente das funções, e o binário vai junto via `includeFiles` no vercel.json.
 *
 * Falhar aqui não derruba a instalação: só a transcrição de links fica
 * indisponível, e ela avisa isso em tempo de execução.
 */

import { mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

const ARQUIVO_POR_PLATAFORMA = {
  linux: 'yt-dlp_linux',
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos'
};

async function main() {
  const remoto = ARQUIVO_POR_PLATAFORMA[process.platform];
  if (!remoto) {
    console.warn(`[yt-dlp] plataforma ${process.platform} sem binário — transcrição de links desativada`);
    return;
  }

  const destino = path.join(RAIZ, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

  // Já baixado: não gasta rede a cada npm install local.
  const existente = await stat(destino).catch(() => null);
  if (existente && existente.size > 1_000_000 && !process.env.VERCEL) {
    console.log(`[yt-dlp] já presente em ${destino}`);
    return;
  }

  const res = await fetch(`${BASE}/${remoto}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download do yt-dlp falhou: HTTP ${res.status}`);

  await mkdir(path.dirname(destino), { recursive: true });
  await writeFile(destino, Buffer.from(await res.arrayBuffer()));
  await chmod(destino, 0o755);
  console.log(`[yt-dlp] baixado em ${destino}`);
}

main().catch((err) => {
  console.warn(`[yt-dlp] ⚠️  ${err.message} — transcrição de links ficará indisponível`);
});
