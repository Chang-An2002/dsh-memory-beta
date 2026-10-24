/**
 * 校验打包产物：`npm pack` 出来的文件里该有的都在、不该有的都不在。
 *
 * 为什么要单独一个脚本：`files` 白名单是"发布内容"的唯一来源，而它出错的方式很安静——
 * 少写一项，npm 上就少一个文件（比如设计文档），本地测试和仓库浏览都不会报错。
 *
 * 用法：
 *
 *   node scripts/check-pack.mjs               # 自己跑 npm pack --dry-run --json
 *   node scripts/check-pack.mjs pack.json     # 读一份已导出的 JSON
 *
 * 第二种用法是为了"禁止子进程管道"的环境（例如 DSH 的沙箱）：
 *
 *   npm pack --dry-run --json > pack.json
 *   node scripts/check-pack.mjs pack.json
 *
 * 零依赖：只用 node 标准库。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

/** 必须在包里的文件（缺一个就是发布事故）。 */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'DESIGN.md',
  'MIGRATION.md',
  'CHANGELOG.md',
  'LICENSE',
  'lib/index.js',
  'lib/memory.js',
  'lib/search.js',
  'lib/synonyms.js',
  'lib/workspace-index.js',
];

/** 绝对不能进包的东西。 */
const FORBIDDEN = [
  'test/',
  'scripts/',
  '.github/',
  'node_modules/',
];

const fromFile = process.argv[2];
const raw = fromFile === undefined
  ? execSync('npm pack --dry-run --json', { encoding: 'utf8' })
  : fs.readFileSync(fromFile, 'utf8');

const [info] = JSON.parse(raw);
const paths = info.files.map((file) => file.path);

const missing = REQUIRED.filter((need) => !paths.includes(need));
const leaked = FORBIDDEN.filter((prefix) => paths.some((path) => path.startsWith(prefix)));

console.log(`打包文件数：${paths.length}`);
console.log(`包大小：${(info.size / 1024).toFixed(1)} kB，解开 ${(info.unpackedSize / 1024).toFixed(1)} kB`);
console.log(`清单：${paths.join('、')}`);

if (missing.length > 0) console.error(`缺少必需文件：${missing.join('、')}`);
if (leaked.length > 0) console.error(`不该进包的内容：${leaked.join('、')}`);

if (missing.length > 0 || leaked.length > 0) process.exit(1);
console.log('打包内容校验通过。');
