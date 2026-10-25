/**
 * 把 DSH 桌面端的 app.asar 解包到磁盘。
 *
 * 为什么需要：DSH 的插件代码在 `resources/app.asar` 里，而 Node 无法直接 import asar
 * 内的文件（`ERR_MODULE_NOT_FOUND`）。要在不启动 GUI 的情况下用 DSH 自己的内核验证插件，
 * 就必须先把 asar 解开。
 *
 * 用法：
 *   node extract-asar.mjs "<DeepSeek Harness>/resources/app.asar" <输出目录>
 *
 * 输出目录里会得到 `node_modules/@deepseek-ai/...` 等文件（约 350 MB）。
 * 这只是临时验证用，不要提交进仓库。
 */
import fs from 'node:fs';
import path from 'node:path';

const [asarPath, outDir] = process.argv.slice(2);
if (asarPath === undefined || outDir === undefined) {
  console.error('用法: node extract-asar.mjs <app.asar 路径> <输出目录>');
  process.exit(1);
}

const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerSize = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const baseOffset = 16 + headerSize;

// 少数条目正文在 app.asar.unpacked/ 下（例如被 Electron 排除的原生模块）
const unpackedRoot = asarPath.replace(/app\.asar$/, 'app.asar.unpacked');

let copied = 0;
const walk = (node, prefix) => {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const rel = `${prefix}/${name}`;
    const target = path.join(outDir, rel);
    if (value.files) {
      fs.mkdirSync(target, { recursive: true });
      walk(value, rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) continue;

    if (value.unpacked) {
      fs.copyFileSync(path.join(unpackedRoot, rel), target);
    } else {
      const buf = Buffer.alloc(Number(value.size));
      fs.readSync(fd, buf, 0, buf.length, baseOffset + Number(value.offset));
      fs.writeFileSync(target, buf);
    }
    copied += 1;
  }
};

walk(header, '');
fs.closeSync(fd);
console.log(`已解包 ${copied} 个文件到 ${outDir}`);
