const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const PRINTS_DIR = path.join(__dirname, 'prints');
const OUTPUT_DIR = path.join(__dirname, 'output');
const CALIB_FILE = path.join(__dirname, 'ocr_calibration.json');
const LOG_FILE = path.join(__dirname, 'ocr_debug.txt');

function log(s) {
  const line = `[${new Date().toISOString()}] ${s}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
  console.log(line.trim());
}

function ensureDirs() {
  try { if (!fs.existsSync(PRINTS_DIR)) fs.mkdirSync(PRINTS_DIR, { recursive: true }); } catch (e) {}
  try { if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (e) {}
}

function defaultCalibration() {
  return {
    columns: {
      codFabricante: { xPct: 0.02, wPct: 0.17 },
      produto: { xPct: 0.195, wPct: 0.53 },
      localizacao: { xPct: 0.73, wPct: 0.12 },
      qtd: { xPct: 0.86, wPct: 0.05 }
    },
    headerBandPx: 28,
    minRowHeightPx: 18
  };
}

let sharedWorker = null;
let workerBusy = false;
const pending = [];

async function ensureWorker() {
  if (!sharedWorker) {
    sharedWorker = await Tesseract.createWorker('por');
  }
  return sharedWorker;
}

async function withWorker(fn) {
  const wk = await ensureWorker();
  // Fila simples para garantir 1 tarefa por vez
  return new Promise((resolve, reject) => {
    pending.push({ fn, resolve, reject, wk });
    pumpQueue();
  });
}

async function pumpQueue() {
  if (workerBusy) return;
  const item = pending.shift();
  if (!item) return;
  workerBusy = true;
  try {
    const out = await item.fn(item.wk);
    item.resolve(out);
  } catch (e) {
    item.reject(e);
  } finally {
    workerBusy = false;
    if (pending.length) setImmediate(pumpQueue);
  }
}

async function ocrHeaderPositions(imgPath) {
  try {
    const ret = await withWorker(async (wk) => {
      await wk.setParameters({ tessedit_pageseg_mode: 6 });
      return await wk.recognize(imgPath);
    });
    const words = ret.data.words || [];
    const hits = [];
    for (const w of words) {
      const t = (w.text || '').toLowerCase();
      if (t.includes('cod') || t.includes('cód') || t.includes('produto') || t.includes('localiza') || t.startsWith('qtd') || t.startsWith('qtde')) {
        hits.push({ t, x: (w.bbox.x0 + w.bbox.x1) / 2, y: (w.bbox.y0 + w.bbox.y1) / 2 });
      }
    }
    if (!hits.length) return null;
    const img = sharp(imgPath);
    const meta = await img.metadata();
    const width = meta.width || 1600;
    const headerY = Math.min(...hits.map(h => h.y));
    const map = {};
    for (const h of hits) {
      if (h.t.includes('produto')) map.produto = Math.min(map.produto ?? Infinity, h.x);
      if (h.t.includes('localiza')) map.localizacao = Math.min(map.localizacao ?? Infinity, h.x);
      if (h.t.startsWith('qtd') || h.t.startsWith('qtde')) map.qtd = Math.min(map.qtd ?? Infinity, h.x);
      if (h.t.startsWith('cod') || h.t.startsWith('cód')) map.cod = Math.min(map.cod ?? Infinity, h.x);
    }
    if (!map.cod || !map.produto || !map.localizacao || !map.qtd) return null;
    const xs = {
      codFabricante: map.cod / width,
      produto: map.produto / width,
      localizacao: map.localizacao / width,
      qtd: map.qtd / width
    };
    const keys = ['codFabricante', 'produto', 'localizacao', 'qtd'];
    const sorted = keys.sort((a, b) => xs[a] - xs[b]);
    const wPct = {};
    for (let i = 0; i < sorted.length; i++) {
      const k = sorted[i];
      const nextX = i < sorted.length - 1 ? xs[sorted[i + 1]] : 0.95;
      const start = xs[k];
      wPct[k] = Math.max(0.03, nextX - start - 0.01);
    }
    return {
      columns: {
        codFabricante: { xPct: xs.codFabricante, wPct: wPct.codFabricante },
        produto: { xPct: xs.produto, wPct: wPct.produto },
        localizacao: { xPct: xs.localizacao, wPct: wPct.localizacao },
        qtd: { xPct: xs.qtd, wPct: wPct.qtd }
      },
      headerBandPx: Math.max(24, Math.round(meta.height * 0.03)),
      minRowHeightPx: Math.max(16, Math.round(meta.height * 0.02))
    };
  } catch (e) {
    return null;
  }
}

async function calibrateFromReferences() {
  const p1 = path.join(PRINTS_DIR, 'reference_1.png');
  const p2 = path.join(PRINTS_DIR, 'reference_2.png');
  if (!fs.existsSync(p1) || !fs.existsSync(p2)) {
    return defaultCalibration();
  }
  const c1 = await ocrHeaderPositions(p1);
  const c2 = await ocrHeaderPositions(p2);
  if (!c1 && !c2) return defaultCalibration();
  const pick = (a, b) => a != null ? a : b;
  const columns = {
    codFabricante: {
      xPct: pick(c1?.columns.codFabricante.xPct, c2?.columns.codFabricante.xPct),
      wPct: pick(c1?.columns.codFabricante.wPct, c2?.columns.codFabricante.wPct)
    },
    produto: {
      xPct: pick(c1?.columns.produto.xPct, c2?.columns.produto.xPct),
      wPct: pick(c1?.columns.produto.wPct, c2?.columns.produto.wPct)
    },
    localizacao: {
      xPct: pick(c1?.columns.localizacao.xPct, c2?.columns.localizacao.xPct),
      wPct: pick(c1?.columns.localizacao.wPct, c2?.columns.localizacao.wPct)
    },
    qtd: {
      xPct: pick(c1?.columns.qtd.xPct, c2?.columns.qtd.xPct),
      wPct: pick(c1?.columns.qtd.wPct, c2?.columns.qtd.wPct)
    }
  };
  const headerBandPx = Math.round(((c1?.headerBandPx || 0) + (c2?.headerBandPx || 0)) / Math.max(1, [c1, c2].filter(Boolean).length)) || defaultCalibration().headerBandPx;
  const minRowHeightPx = Math.round(((c1?.minRowHeightPx || 0) + (c2?.minRowHeightPx || 0)) / Math.max(1, [c1, c2].filter(Boolean).length)) || defaultCalibration().minRowHeightPx;
  return { columns, headerBandPx, minRowHeightPx };
}

async function writeCalibration() {
  const calib = await calibrateFromReferences();
  try { fs.writeFileSync(CALIB_FILE, JSON.stringify(calib, null, 2)); } catch (e) {}
  return calib;
}

function readCalibration() {
  if (!fs.existsSync(CALIB_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch (e) { return null; }
}

async function preprocessBuffer(buf, level) {
  const factor = level === 'strong' ? 1.35 : 1.15;
  const med = level === 'strong' ? 3 : 1;
  const thr = level === 'strong' ? 140 : 128;
  // Pipeline somente com sharp (mais rápido e nativo)
  return await sharp(buf)
    .grayscale()
    .linear(factor, 0)
    .median(med)
    .sharpen(level === 'strong' ? { sigma: 1.0 } : { sigma: 0.6 })
    .threshold(thr, { grayscale: true })
    .toBuffer();
}

async function detectHeaderAndBody(buf, calib) {
  const tmp = path.join(PRINTS_DIR, `tmp_${Date.now()}.png`);
  try { fs.writeFileSync(tmp, buf); } catch (e) {}
  let headerY = 0;
  try {
    const ret = await withWorker(async (wk) => {
      await wk.setParameters({ tessedit_pageseg_mode: 6 });
      return await wk.recognize(tmp);
    });
    const words = ret.data.words || [];
    const band = words.filter(w => {
      const t = (w.text || '').toLowerCase();
      return t.includes('cod') || t.includes('cód') || t.includes('produto') || t.includes('localiza') || t.startsWith('qtd') || t.startsWith('qtde');
    });
    if (band.length) headerY = Math.min(...band.map(w => w.bbox.y1));
  } catch (e) {}
  try { fs.unlinkSync(tmp); } catch (e) {}
  const meta = await sharp(buf).metadata();
  const y0 = Math.max(0, Math.round(headerY || calib.headerBandPx));
  const y1 = meta.height || 800;
  return { x: 0, y: y0, width: meta.width || 1600, height: y1 - y0 };
}

async function projectRowGaps(cropBuf, calib) {
  const { data, info } = await sharp(cropBuf).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels; // should be 1 after threshold() but handle >1
  const rowSums = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const rowOffset = y * w * ch;
    for (let x = 0; x < w; x++) {
      const v = data[rowOffset + x * ch]; // first channel
      // After threshold: 0 or 255
      s += v < 128 ? 1 : 0;
    }
    rowSums[y] = s;
  }
  const gaps = [];
  const thr = Math.max(3, Math.round(w * 0.005));
  let inGap = false;
  let start = 0;
  for (let y = 0; y < h; y++) {
    if (rowSums[y] <= thr) {
      if (!inGap) {
        inGap = true;
        start = y;
      }
    } else {
      if (inGap) {
        gaps.push([start, y - 1]);
        inGap = false;
      }
    }
  }
  if (inGap) gaps.push([start, h - 1]);
  const bands = [];
  let prev = 0;
  for (const g of gaps) {
    const top = prev;
    const bottom = g[0] - 1;
    if (bottom - top >= calib.minRowHeightPx) bands.push([top, bottom]);
    prev = g[1] + 1;
  }
  if (h - prev >= calib.minRowHeightPx) bands.push([prev, h - 1]);
  return bands.slice(0, 200);
}

function cellBoxes(body, calib) {
  const w = body.width;
  const mk = (k) => ({ x: Math.round(w * calib.columns[k].xPct), width: Math.round(w * calib.columns[k].wPct) });
  return {
    codFabricante: mk('codFabricante'),
    produto: mk('produto'),
    localizacao: mk('localizacao'),
    qtd: mk('qtd')
  };
}

function normText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function validCod(s) {
  const t = s.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{10,15}$/.test(t);
}

function validLoc(s) {
  const t = s.replace(/\s+/g, ' ').toUpperCase();
  return /^\\d+\\s*[A-Z]\\s*\\d+$/.test(t);
}

function validQtd(s) {
  const t = s.replace(/[^\d]/g, '');
  return t.length > 0 && /^\d+$/.test(t);
}

async function ocrCell(buf, psm, whitelist) {
  try {
    const ret = await withWorker(async (wk) => {
      await wk.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist || '' });
      return await wk.recognize(buf);
    });
    return normText(ret.data.text || '');
  } catch (e) {
    return '';
  }
}

async function readCellWithRetries(buf, kind) {
  const configs = [];
  if (kind === 'qtd') configs.push({ psm: 7, wl: '0123456789' }, { psm: 13, wl: '0123456789' });
  else if (kind === 'cod') configs.push({ psm: 7, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' }, { psm: 13, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' });
  else if (kind === 'loc') configs.push({ psm: 7, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' }, { psm: 6, wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' });
  else configs.push({ psm: 6, wl: '' }, { psm: 3, wl: '' });
  for (const level of ['normal', 'strong']) {
    const pre = await preprocessBuffer(buf, level);
    for (const c of configs) {
      const txt = await ocrCell(pre, c.psm, c.wl);
      if (kind === 'qtd' && validQtd(txt)) return txt.replace(/[^\d]/g, '');
      if (kind === 'cod' && validCod(txt)) return txt.replace(/\s+/g, '').toUpperCase();
      if (kind === 'loc' && validLoc(txt)) return txt.toUpperCase().replace(/\s+/g, ' ');
      if (kind === 'prod' && txt.length >= 2) return txt;
    }
  }
  return '';
}

async function extractFromImage(imgPath, calib) {
  log(`Processando ${imgPath}`);
  const raw = await sharp(imgPath).toBuffer();
  const body = await detectHeaderAndBody(raw, calib);
  const roiBuf = await sharp(raw).extract({ left: body.x, top: body.y, width: body.width, height: body.height }).toBuffer();
  const binBuf = await preprocessBuffer(roiBuf, 'strong');
  const rows = await projectRowGaps(binBuf, calib);
  const cols = cellBoxes(body, calib);
  const items = [];
  for (const band of rows) {
    const top = Math.max(0, band[0]);
    const height = Math.max(1, band[1] - band[0] + 1);
    const y = top;
    const cropCell = async (cx, cw) => {
      const buf = await sharp(binBuf).extract({ left: cx, top: y, width: Math.min(cw, body.width - cx), height }).toBuffer();
      return buf;
    };
    const codBuf = await cropCell(cols.codFabricante.x, cols.codFabricante.width);
    const prodBuf = await cropCell(cols.produto.x, cols.produto.width);
    const locBuf = await cropCell(cols.localizacao.x, cols.localizacao.width);
    const qtdBuf = await cropCell(cols.qtd.x, cols.qtd.width);
    const codTxt = await readCellWithRetries(codBuf, 'cod');
    const prodTxt = await readCellWithRetries(prodBuf, 'prod');
    const locTxt = await readCellWithRetries(locBuf, 'loc');
    const qtdTxt = await readCellWithRetries(qtdBuf, 'qtd');
    const ok = validCod(codTxt) && validLoc(locTxt) && validQtd(qtdTxt) && prodTxt.length > 0;
    if (!ok) continue;
    items.push({
      codFabricante: codTxt,
      produto: prodTxt,
      localizacao: locTxt,
      quantidade: parseInt(qtdTxt, 10)
    });
  }
  const base = path.basename(imgPath);
  const nfMatch = base.match(/(\d{5,})/);
  const nf = nfMatch ? nfMatch[1] : base.replace(/\.png$/i, '');
  const out = {
    notaFiscal: nf,
    "chave-acesso": "",
    itens: items
  };
  return out;
}

function isImageFile(f) {
  if (!(/\.(png|jpg|jpeg)$/i.test(f))) return false;
  // Somente processar imagens de NF e referências
  // etiqueta_items_*.png ou reference_*.png
  return /^etiqueta_items_\d+\.png$/i.test(f) || /^reference_\d+\.png$/i.test(f);
}

async function processImage(imgPath, calib) {
  try {
    // Pular se já houver JSON correspondente
    const base = path.basename(imgPath).replace(/\.[a-z]+$/i, '');
    const outFile = path.join(OUTPUT_DIR, `${base.replace(/[^0-9]/g, '') || base}.json`);
    if (fs.existsSync(outFile)) {
      log(`Ignorado (já processado): ${imgPath}`);
      return;
    }
    const out = await extractFromImage(imgPath, calib);
    const nf = out.notaFiscal || base;
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    log(`Gerado ${outFile} com ${out.itens.length} itens`);
  } catch (e) {
    log(`Falha ao processar ${imgPath}: ${e.message}`);
  }
}

async function main() {
  ensureDirs();
  let calib = readCalibration();
  if (!calib) {
    log('Calibrando colunas');
    calib = await writeCalibration();
    log('Calibração pronta');
  }
  const existing = fs.readdirSync(PRINTS_DIR).filter(isImageFile);
  for (const f of existing) {
    await processImage(path.join(PRINTS_DIR, f), calib);
  }
  let debounce = {};
  fs.watch(PRINTS_DIR, { persistent: true }, async (evt, filename) => {
    if (!filename) return;
    const full = path.join(PRINTS_DIR, filename);
    if (!isImageFile(filename)) return;
    clearTimeout(debounce[full]);
    debounce[full] = setTimeout(async () => {
      if (fs.existsSync(full)) await processImage(full, calib);
    }, 700);
  });
  log('Monitorando pasta /prints');
}

if (require.main === module) {
  main().catch(e => {
    log(`Erro: ${e.message}`);
    process.exit(1);
  });
}
