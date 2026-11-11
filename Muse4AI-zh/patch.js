// Muse4AI 简体中文汉化补丁
// 原理：Muse4AI 的 "English" 界面是用「越南语原文 -> 英文」词典翻译的。本脚本把英文译文换成中文，
// 并让界面固定使用这套译文（不再受「越南语」设置影响）。
// 做法：直接重建 resources\app.asar（原文件备份为 app.asar.orig，删除即可还原）。
//
// 用法: node patch.js [--force] [--root <安装目录>] [--version <版本号>]
'use strict';
process.noAsar = true; // 用 Muse4AI.exe (ELECTRON_RUN_AS_NODE) 运行时，把 .asar 当普通文件读
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const PATCH_VER = 3;
const HERE = __dirname;
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const FORCE = argv.includes('--force');
const ROOT = opt('--root') || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Muse4AI');

let logBuf = [];
const log = (...a) => logBuf.push(a.join(' '));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const zhFile = path.join(HERE, 'zh-CN.json');
let ZH;
try { ZH = JSON.parse(fs.readFileSync(zhFile, 'utf8')); } catch (e) {
  console.log('错误: 无法读取翻译表 zh-CN.json: ' + e.message);
  console.log('@@STATUS ' + JSON.stringify({ status: 'error', message: 'zh-CN.json 读取失败' }));
  process.exit(2);
}
for (const k of Object.keys(ZH)) if (typeof ZH[k] !== 'string' || ZH[k] === '') delete ZH[k];
const has = (k) => Object.prototype.hasOwnProperty.call(ZH, k);
const zhHash = sha256(fs.readFileSync(zhFile)).slice(0, 16);

// ---------------------------------------------------------------- 目标版本
function listVersions() {
  const v = opt('--version');
  if (v) return [v];
  const all = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT).filter((n) => /^app-/.test(n) && (fs.existsSync(path.join(ROOT, n, 'resources', 'app.asar')) || fs.existsSync(path.join(ROOT, n, 'resources', 'app.asar.orig'))))
      .map((n) => n.slice(4))
    : [];
  const curFile = path.join(ROOT, 'current.txt');
  const cur = fs.existsSync(curFile) ? fs.readFileSync(curFile, 'utf8').trim() : '';
  return cur && all.includes(cur) ? [cur, ...all.filter((x) => x !== cur)] : all;
}

// ---------------------------------------------------------------- ASAR 读取
function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerPickle = head.readUInt32LE(4);
  const strLen = head.readUInt32LE(12);
  const hb = Buffer.alloc(strLen);
  fs.readSync(fd, hb, 0, strLen, 16);
  const tree = JSON.parse(hb.toString('utf8'));
  const base = 8 + headerPickle;
  const read = (e) => {
    if (e.unpacked) return fs.readFileSync(path.join(file + '.unpacked', ...e.path.split('/')));
    const b = Buffer.alloc(e.size);
    if (e.size) fs.readSync(fd, b, 0, e.size, base + Number(e.offset));
    return b;
  };
  return {
    tree,
    read,
    close() { fs.closeSync(fd); },
  };
}

// 把 header 树展开成 [{path, entry}]，并给出读取内容的方法
function flatten(tree, asar, file) {
  const out = [];
  (function walk(node, rel) {
    for (const [name, e] of Object.entries(node.files || {})) {
      const p = rel ? rel + '/' + name : name;
      if (e.files) { out.push({ path: p, dir: true, entry: e }); walk(e, p); }
      else if (e.link) out.push({ path: p, link: e.link });
      else out.push({ path: p, dir: false, entry: { ...e, path: p }, size: e.size, offset: e.offset, unpacked: !!e.unpacked });
    }
  })(tree, '');
  return out;
}

// ---------------------------------------------------------------- ASAR 打包
function packAsar(items) {
  // items: [{path, dir} | {path, buf}]
  let offset = 0;
  const blobs = [];
  const tree = { files: {} };
  for (const it of items) {
    const parts = it.path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.files[seg]) node.files[seg] = { files: {} };
      node = node.files[seg];
    }
    const name = parts[parts.length - 1];
    if (it.dir) { node.files[name] = { files: {} }; continue; }
    if (it.link) { node.files[name] = { link: it.link }; continue; }
    const buf = it.buf;
    const blocks = [];
    for (let i = 0; i < buf.length; i += 4194304) blocks.push(sha256(buf.subarray(i, i + 4194304)));
    node.files[name] = {
      size: buf.length,
      offset: String(offset),
      integrity: { algorithm: 'SHA256', hash: sha256(buf), blockSize: 4194304, blocks },
    };
    blobs.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padded = (json.length + 3) & ~3;
  const payload = 4 + padded;                 // 负载 = 长度字段 + 对齐后的 json
  const pickle = Buffer.alloc(4 + payload);   // [payload][jsonLen][json][padding]
  pickle.writeUInt32LE(payload, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const outer = Buffer.alloc(8);
  outer.writeUInt32LE(4, 0);
  outer.writeUInt32LE(pickle.length, 4);
  return { data: Buffer.concat([outer, pickle, ...blobs]), tree };
}

// ---------------------------------------------------------------- 简易 JS 词法：匹配右括号
function findClose(s, i) {
  const stack = [];
  const closeOf = { '(': ')', '[': ']', '{': '}' };
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue; }
    if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (c === '`') { i = skipTpl(s, i + 1); if (i < 0) return -1; continue; }
    if (c in closeOf) stack.push(closeOf[c]);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
  function skipTpl(s, j) {
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '`') return j;
      if (s[j] === '$' && s[j + 1] === '{') { const e = findClose(s, j + 1); if (e < 0) return -1; j = e; }
    }
    return -1;
  }
}

const VI = /[\u00C0-\u1EF9]/;
const DICT_RE = /Object\.assign\(\s*(\/\*\s*@__PURE__\s*\*\/\s*)?Object\.create\(null\)\s*,/g;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let untranslated = new Set();
let report = {};

function prelude() {
  return 'var __ZH_CN=' + JSON.stringify(ZH) + ';' +
    'function __zhAssign(t){var h=Object.prototype.hasOwnProperty;for(var i=1;i<arguments.length;i++){var s=arguments[i];if(s)for(var k in s){var v=s[k];t[k]=(typeof v==="string"&&h.call(__ZH_CN,v))?__ZH_CN[v]:v}}return t}\n';
}
function evalObj(src) { try { return vm.runInNewContext('(' + src + ')', Object.create(null), { timeout: 5000 }); } catch { return null; } }

function patchJs(code) {
  let changed = false;
  // 1) 词典：Object.assign(Object.create(null), …) -> __zhAssign(…)
  code = code.replace(DICT_RE, (m, _c, idx) => {
    const after = code.slice(idx + m.length, idx + m.length + 400);
    if (!(VI.test(after) || /_default\b/.test(after))) return m;
    report.dicts++; changed = true;
    const open = idx + m.indexOf('(');
    const close = findClose(code, open);
    if (close > 0) {
      const args = code.slice(idx + m.length, close);
      const parts = [];
      let j = 0;
      while (j < args.length) {
        while (j < args.length && /[\s,]/.test(args[j])) j++;
        if (j >= args.length) break;
        if (args[j] === '{') { const e = findClose(args, j); if (e < 0) break; parts.push(args.slice(j, e + 1)); j = e + 1; }
        else { const mm = /^[\w$]+/.exec(args.slice(j)); if (!mm) break; parts.push(mm[0]); j += mm[0].length; }
      }
      for (const p of parts) {
        let src = p;
        if (p[0] !== '{') { const d = code.indexOf('var ' + p + ' = {'); if (d < 0) continue; const st = code.indexOf('{', d); const e = findClose(code, st); if (e < 0) continue; src = code.slice(st, e + 1); }
        const obj = evalObj(src);
        if (!obj) continue;
        for (const v of Object.values(obj)) if (typeof v === 'string' && /[A-Za-z]/.test(v)) { report.dictValues++; if (has(v)) report.dictHit++; else untranslated.add(v); }
      }
    }
    return '__zhAssign(Object.create(null),';
  });
  // 2) 内联 {en:`…`, vi:`…`} / { en: "…", vi: "…" }
  code = code.replace(/\ben:(\s*)`((?:[^`\\]|\\[\s\S])*)`(?=\s*,\s*vi:)/g, (m, sp, raw) => {
    if ((raw.match(/\$\{/g) || []).length !== (raw.match(/\$\{[^}]*\}/g) || []).length) return m;
    if (!/[A-Za-z]/.test(raw)) return m;
    report.inline++;
    if (!has(raw)) { untranslated.add(raw); return m; }
    report.inlineHit++; changed = true;
    return 'en:' + sp + '`' + ZH[raw] + '`';
  });
  code = code.replace(/\ben:(\s*)"((?:[^"\\\n]|\\.)*)"(?=\s*,\s*vi:)/g, (m, sp, raw) => {
    let v; try { v = JSON.parse('"' + raw + '"'); } catch { return m; }
    if (!/[A-Za-z]/.test(v)) return m;
    report.inline++;
    if (!has(v)) { untranslated.add(v); return m; }
    report.inlineHit++; changed = true;
    return 'en:' + sp + JSON.stringify(ZH[v]);
  });
  // 3) 语言菜单：只保留「简体中文」
  code = code.replace(/\[\{id:`vi`,label:`[^`]*`\},\{id:`en`,label:`[^`]*`\}\]/g, () => {
    report.label++; changed = true;
    return '[{id:`en`,label:`简体中文`}]';
  });
  code = code.replace(/\{id:`en`,label:`English`\}/g, () => { report.label++; changed = true; return '{id:`en`,label:`简体中文`}'; });
  // 4) 语言开关：只接受 "en"（英文译文已被换成中文），存着 "vi" 也会回落到中文
  if (code.includes('function b(e){return e===`vi`||e===`en`}')) {
    code = code.replace('function b(e){return e===`vi`||e===`en`}', 'function b(e){return e===`en`}');
    report.localeForce++; changed = true;
  }
  const isLocaleMain = /function isLocale\(v\) \{\s*return v === "vi" \|\| v === "en";\s*\}/;
  if (isLocaleMain.test(code)) { code = code.replace(isLocaleMain, 'function isLocale(v) {\n  return v === "en";\n}'); report.localeForce++; changed = true; }
  // 5) 月份
  const q = '([`"\'])';
  const monthRe = new RegExp('\\[\\s*' + MONTHS_EN.map((mo, i) => (i ? '\\s*,\\s*' : '') + (i ? '\\1' : q) + mo + '\\1').join('') + '\\s*\\]', 'g');
  code = code.replace(monthRe, (m, quote) => { report.months++; changed = true; return '[' + MONTHS_EN.map((_, i) => quote + (i + 1) + '月' + quote).join(',') + ']'; });

  if (!changed) return null;
  if (report.dicts && code.includes('__zhAssign(')) {
    const m = /^(\s*(["'])use strict\2;?\s*\n?)/.exec(code);
    code = m ? m[1] + prelude() + code.slice(m[1].length) : prelude() + code;
  }
  return code;
}

function patchCss(css) {
  return css.replace(/--font-sans:([^;}]+)/g, (m, val) => {
    if (/YaHei/i.test(val)) return m;
    const fams = val.split(',').map((x) => x.trim());
    let at = fams.findIndex((f) => /^(system-ui|sans-serif|ui-sans-serif)$/i.test(f));
    if (at < 0) at = fams.length;
    fams.splice(at, 0, '"Microsoft YaHei UI"', '"Microsoft YaHei"', '"PingFang SC"');
    return '--font-sans:' + fams.join(', ');
  });
}

// ---------------------------------------------------------------- 单个版本
function patchOne(version) {
  const appDir = path.join(ROOT, 'app-' + version);
  const resDir = path.join(appDir, 'resources');
  const asarPath = path.join(resDir, 'app.asar');
  const origPath = path.join(resDir, 'app.asar.orig');
  const markerPath = path.join(resDir, '.zh-patch.json');
  const folderPath = path.join(resDir, 'app'); // 旧方案留下的文件夹，清掉

  // 还原备份后没有 asar 的异常状态
  if (!fs.existsSync(asarPath) && fs.existsSync(origPath)) { fs.renameSync(origPath, asarPath); log(`  ${version}: 恢复上次中断的 asar`); }
  if (!fs.existsSync(asarPath)) return { version, status: 'skip' };

  // 已经打过补丁但原版备份丢了：无法安全重打
  if (fs.existsSync(markerPath) && !fs.existsSync(origPath)) {
    return { version, status: 'error', message: '已汉化但原版 app.asar.orig 备份丢失，请运行卸载脚本或重装该版本。' };
  }
  // 第一次打补丁：备份原版 asar；之后一律在备份上重建，避免补丁叠加
  if (!fs.existsSync(origPath)) {
    fs.copyFileSync(asarPath, origPath);
    log('  已备份原始 app.asar → app.asar.orig');
  }

  // 标记用「原版 asar」的属性，这样重复运行能正确判定为「已汉化」
  const stat = fs.statSync(origPath);
  const stamp = { patchVer: PATCH_VER, appVersion: version, asarSize: stat.size, asarMtime: stat.mtimeMs, zhHash };
  if (!FORCE && fs.existsSync(markerPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (Object.keys(stamp).every((k) => m[k] === stamp[k])) return { version, status: 'already' };
    } catch { /* 标记损坏 */ }
  }

  report = { dicts: 0, dictValues: 0, dictHit: 0, inline: 0, inlineHit: 0, label: 0, localeForce: 0, months: 0 };
  untranslated = new Set();
  log(`Muse4AI 汉化补丁 → 版本 ${version}`);

  // 第一次打补丁：把原版 asar 备份下来，之后都在备份上做（避免重复补丁叠加）
  const srcPath = origPath;

  const asar = readAsar(srcPath);
  const items = [];
  try {
    for (const f of flatten(asar.tree, asar)) {
      if (f.link) { items.push({ path: f.path, dir: false, buf: Buffer.from(''), link: f.link }); continue; }
      if (f.dir) { items.push({ path: f.path, dir: true }); continue; }
      let buf = asar.read(f.entry);
      if (/\.(c|m)?js$/.test(f.path) && !f.path.includes('node_modules/')) {
        const out = patchJs(buf.toString('utf8'));
        if (out !== null) { buf = Buffer.from(out, 'utf8'); log('  已处理 ' + f.path); }
      } else if (/\.css$/.test(f.path)) {
        buf = Buffer.from(patchCss(buf.toString('utf8')), 'utf8');
      }
      items.push({ path: f.path, buf });
    }
  } finally { asar.close(); }

  if (!report.dicts || !report.localeForce) {
    return { version, status: 'error', message: '没有找到翻译词典或语言开关，可能是新版本改了结构，需要更新补丁脚本。' };
  }

  const { data } = packAsar(items);

  // 自检：重新解析新 asar，确认头部字段自洽、能读回文件
  const checkFile = path.join(resDir, 'app.asar.new');
  fs.writeFileSync(checkFile, data);
  let ok = true;
  try {
    const hb = fs.readFileSync(checkFile, { encoding: null }).subarray(0, 16);
    const A = hb.readUInt32LE(0), B = hb.readUInt32LE(4), C = hb.readUInt32LE(8), D = hb.readUInt32LE(12);
    const padded = (D + 3) & ~3;
    if (A !== 4 || C !== 4 + padded || B !== 4 + C) { ok = false; log(`  头部字段异常 A=${A} B=${B} C=${C} D=${D}`); }
    const v2 = readAsar(checkFile);
    const fl = flatten(v2.tree, v2);
    const js = fl.find((x) => /main\.cjs$/.test(x.path));
    const code = v2.read(js.entry).toString('utf8');
    if (!code.includes('__ZH_CN=') && !code.includes('简体中文')) ok = false;
    v2.close();
  } catch (e) { ok = false; log('  自检失败: ' + e.message); }
  if (!ok) { fs.rmSync(checkFile, { force: true }); return { version, status: 'error', message: '重建的 app.asar 自检失败，未替换。' }; }

  try {
    fs.renameSync(checkFile, asarPath); // 同一个卷内原子替换
  } catch (e) {
    // Windows 上目标可能被占用：先删后改名
    try { fs.rmSync(asarPath, { force: true }); fs.renameSync(checkFile, asarPath); }
    catch { fs.rmSync(checkFile, { force: true }); return { version, status: 'error', message: 'app.asar 正在被占用，请先完全退出 Muse4AI（托盘图标 → 退出）后再试。' }; }
  }
  if (fs.existsSync(folderPath)) { try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch {} }

  fs.writeFileSync(markerPath, JSON.stringify({ ...stamp, origSize: fs.statSync(srcPath).size, patchedAt: new Date().toISOString(), report }, null, 2));

  const total = report.dictValues + report.inline, hit = report.dictHit + report.inlineHit;
  const coverage = +(hit / Math.max(total, 1) * 100).toFixed(1);
  log(`  完成：词典 ${report.dictHit}/${report.dictValues}，内联 ${report.inlineHit}/${report.inline}，语言 ${report.label} 处，语言开关 ${report.localeForce} 处，月份 ${report.months} 处，覆盖率 ${coverage}%`);
  return { version, status: 'patched', coverage, untranslated: untranslated.size };
}

// ---------------------------------------------------------------- 主流程
const results = [];
for (const v of listVersions()) results.push(patchOne(v));
if (!results.length) results.push({ status: 'error', message: '找不到已安装的 Muse4AI。' });
if (untranslated.size) fs.writeFileSync(path.join(HERE, 'untranslated.json'), JSON.stringify([...untranslated], null, 1));

const err = results.find((r) => r.status === 'error');
const patched = results.filter((r) => r.status === 'patched');
results.forEach((r) => log(`${r.version || '-'}: ${r.status}${r.coverage !== undefined ? ' ' + r.coverage + '%' : ''}${r.message ? ' — ' + r.message : ''}`));
console.log(logBuf.join('\n'));
console.log('@@STATUS ' + JSON.stringify({ status: err ? 'error' : (patched.length ? 'patched' : 'already'), versions: results, message: err ? err.message : undefined }));
process.exit(err ? 2 : 0);