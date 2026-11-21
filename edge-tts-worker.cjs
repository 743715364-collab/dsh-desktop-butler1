'use strict';

/**
 * Edge TTS 子进程 worker。
 *
 * DSH 宿主对 profile 里外部 CJS 包的 require 有包装（createRequire.resolve.paths
 * 不兼容），而 msedge-tts 是纯 CJS + ws/axios。与其在宿主里和加载器搏斗，不如
 * 每次合成拉起一个干净的 Node 进程：
 *   - stdin:  { text, voice, rate, pitch, volume }
 *   - stdout: { ok: true, audio: <base64>, mime: 'audio/webm' } 或 { ok: false, error }
 * 由父进程用 ELECTRON_RUN_AS_NODE=1 拉起，不依赖系统装没装 node。
 */

const entry = process.env.EDGE_TTS_ENTRY;
if (!entry) {
  process.stdout.write(JSON.stringify({ ok: false, error: '缺少 EDGE_TTS_ENTRY' }));
  process.exit(1);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  try {
    const options = JSON.parse(input || '{}');
    const text = escapeXml(String(options.text || '')).trim();
    if (!text) throw new Error('要合成的文本为空');
    const voice = String(options.voice || 'zh-CN-YunxiNeural');
    const rate = String(options.rate || '+2%');
    const pitch = String(options.pitch || '+0Hz');
    const volume = String(options.volume || '+0%');

    const mod = require(entry);
    const tts = new mod.MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 30000 });
    await tts.setMetadata(voice, mod.OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(text, { rate, pitch, volume });
    const chunks = [];
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      audioStream.on('end', () => done(resolve));
      audioStream.on('close', () => done(resolve));
      audioStream.on('error', (error) => done(reject, error));
    });
    const buffer = Buffer.concat(chunks);
    try {
      tts.close();
    } catch {
      /* ignore */
    }
    if (!buffer.length) throw new Error('empty audio');
    process.stdout.write(JSON.stringify({ ok: true, audio: buffer.toString('base64'), mime: 'audio/webm' }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
});
