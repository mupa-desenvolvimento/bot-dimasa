const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

function __loadEnvFile(p) {
  try {
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8');
      t.split(/\r?\n/).forEach(l => {
        const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) return;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = v;
      });
    }
  } catch (e) {}
}
__loadEnvFile(path.resolve(__dirname, '..', '.env'));

const PRINTS_DIR = __dirname;
const LANG = process.env.TESS_LANG || 'por';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function parseTabela(text) {
  const linhas = text.split('\n');
  const itens = [];
  for (let linha of linhas) {
    if (!linha.trim()) continue;
    const l = linha.trim();
    const lower = l.toLowerCase();
    if (lower.includes('cod') && lower.includes('produto')) continue;
    const colunas = l.split(/\s{2,}/);
    if (colunas.length >= 4) {
      const qtdNum = parseInt(colunas[3].trim().replace(/[^\d]/g, ''), 10);
      if (Number.isNaN(qtdNum)) continue;
      const cod = colunas[0].trim();
      const prod = colunas[1].trim();
      const loc = colunas[2].trim();
      if (!cod || !prod || !loc) continue;
      itens.push({
        codFabricante: cod,
        produto: prod,
        localizacao: loc,
        quantidade: String(qtdNum)
      });
      continue;
    }
    const tokens = l.split(/\s+/).filter(Boolean);
    if (tokens.length < 4) continue;
    let qtyIndex = -1;
    for (let i = tokens.length - 1; i >= 1; i--) {
      const t = tokens[i].replace(/[^\d]/g, '');
      if (t) {
        qtyIndex = i;
        break;
      }
    }
    if (qtyIndex <= 1) continue;
    const quantidade = tokens[qtyIndex].replace(/[^\d]/g, '');
    const codFabricante = tokens[0];
    const localizacao = tokens[qtyIndex - 1];
    const produto = tokens.slice(1, qtyIndex - 1).join(' ');
    if (codFabricante && produto && localizacao && quantidade) {
      itens.push({ codFabricante, produto, localizacao, quantidade });
    }
  }
  return itens;
}

async function processFile(filePath) {
  const base = path.basename(filePath);
  let itens = [];
  if (OPENAI_API_KEY && typeof fetch === 'function') {
    try {
      itens = await parseWithOpenAIVision(filePath);
    } catch (e) {
      console.error(`OpenAI falhou para ${base}: ${e.message}. Caindo para Tesseract.`);
      const { data: { text } } = await Tesseract.recognize(filePath, LANG, { logger: () => {} });
      itens = await parseTabela(text);
    }
  } else {
    const { data: { text } } = await Tesseract.recognize(filePath, LANG, { logger: () => {} });
    itens = await parseTabela(text);
  }
  return { file: base, itens };
}

async function parseWithOpenAIVision(imagePath) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const prompt = [
    'Leia a imagem de uma grade de itens com as colunas:',
    '1) Cod Fabricante, 2) Produto, 3) Localização, 4) Qtd.',
    'Retorne apenas JSON no formato abaixo (sem texto extra):',
    '[{ "codFabricante": "", "produto": "", "localizacao": "", "quantidade": "" }]',
    'Regras:',
    '- Ignorar cabeçalhos.',
    '- Ignorar linhas incompletas.',
    '- Trim em todos os campos.',
    '- Quantidade deve conter apenas dígitos.',
  ].join(' ');

  const body = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: `data:image/png;base64,${b64}` }
        ]
      }
    ],
    temperature: 0.1
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\[[\s\S]*\]/);
    if (m) {
      parsed = JSON.parse(m[0]);
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Resposta não é um array JSON');
  }
  return parsed
    .map(it => ({
      codFabricante: String(it.codFabricante || '').trim(),
      produto: String(it.produto || '').trim(),
      localizacao: String(it.localizacao || '').trim(),
      quantidade: String(it.quantidade ?? '').replace(/[^\d]/g, '').trim()
    }))
    .filter(it => it.codFabricante && it.produto && it.localizacao && it.quantidade);
}

async function main() {
  const onlyNF = process.argv.slice(2).find(a => a.startsWith('--nf=')) || '';
  const nfFilter = onlyNF ? onlyNF.split('=')[1] : '';
  const files = fs.existsSync(PRINTS_DIR)
    ? fs.readdirSync(PRINTS_DIR)
        .filter(f => /^etiqueta_items_.*\.png$/i.test(f))
        .filter(f => nfFilter ? f.includes(nfFilter) : true)
        .map(f => path.join(PRINTS_DIR, f))
    : [];

  const out = [];
  for (const file of files) {
    try {
      const res = await processFile(file);
      out.push(res);
      console.log(`OK ${res.file}: ${res.itens.length} itens`);
    } catch (e) {
      out.push({ file: path.basename(file), error: e.message });
      console.error(`ERR ${path.basename(file)}: ${e.message}`);
    }
  }

  const outPath = path.join(PRINTS_DIR, 'test_ocr_results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Resultado salvo em ${outPath}`);
}

main();
