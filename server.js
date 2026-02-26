const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
let XLSX = null;

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const COORDINATES_FILE = path.join(__dirname, 'coordinates.json');
const FILES_DIR = path.join(__dirname, 'files');
const INVOICE_DATA_FILE = path.join(__dirname, 'invoice_data_loop.json');
const OUTPUT_DIR = path.join(__dirname, 'output');
let botProcess = null;
const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL || 'https://zdtdmzlupyqlwmqetvbj.supabase.co/functions/v1/importar-compras';
const SUPABASE_FUNCTION_KEY = process.env.SUPABASE_FUNCTION_KEY || null;

function tryLoadXLSX() {
    if (!XLSX) {
        try { XLSX = require('xlsx'); } catch (e) { XLSX = null; }
    }
    return XLSX;
}

function getLastFileEntry(dir, filterFn = null) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    const files = entries
        .map(name => {
            const fullPath = path.join(dir, name);
            const stat = fs.statSync(fullPath);
            return stat.isFile() ? { name, fullPath, mtime: stat.mtime, size: stat.size } : null;
        })
        .filter(Boolean)
        .filter(f => (typeof filterFn === 'function' ? filterFn(f.name) : true))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0] : null;
}

function convertFileToJson(srcPath) {
    const ext = path.extname(srcPath).toLowerCase();
    const outPath = path.join(FILES_DIR, 'dados.json');
    let result = {};

    if (ext === '.xls' || ext === '.xlsx') {
        if (!tryLoadXLSX()) {
            throw new Error('xlsx library not installed');
        }
        const wb = XLSX.readFile(srcPath, { cellDates: true });
        const sheets = wb.SheetNames.map(name => {
            const ws = wb.Sheets[name];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
            return { name, rows };
        });
        result = { filename: path.basename(srcPath), type: 'excel', sheets };
    } else if (ext === '.csv') {
        const raw = fs.readFileSync(srcPath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
        let rows = [];
        if (lines.length > 0) {
            const headers = lines[0].split(';').length > 1 ? lines[0].split(';') : lines[0].split(',');
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(';').length > 1 ? lines[i].split(';') : lines[i].split(',');
                const obj = {};
                headers.forEach((h, idx) => { obj[h.trim()] = (parts[idx] || '').trim(); });
                rows.push(obj);
            }
        }
        result = { filename: path.basename(srcPath), type: 'csv', rows };
    } else {
        throw new Error(`Unsupported file type: ${ext}`);
    }

    try {
        if (fs.existsSync(FILES_DIR)) {
            const entries = fs.readdirSync(FILES_DIR);
            entries.forEach(name => {
                const full = path.join(FILES_DIR, name);
                try {
                    if (fs.statSync(full).isFile() && path.extname(name).toLowerCase() === '.json') {
                        fs.unlinkSync(full);
                    }
                } catch (e) {}
            });
        }
    } catch (e) {}

    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    fs.unlinkSync(srcPath);
    const stat = fs.statSync(outPath);
    return {
        jsonFile: path.basename(outPath),
        size: stat.size,
        result
    };
}

function startFilesWatcher() {
    try {
        if (!fs.existsSync(FILES_DIR)) {
            fs.mkdirSync(FILES_DIR, { recursive: true });
        }
    } catch (e) {}
    let busy = false;
    try {
        fs.watch(FILES_DIR, { persistent: true }, (eventType, filename) => {
            if (!filename) return;
            const ext = path.extname(filename).toLowerCase();
            if (busy) return;
            busy = true;
            setTimeout(() => {
                try {
                    const fullPath = path.join(FILES_DIR, filename);
                    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                        if (ext === '.json') {
                            sendJsonToSupabase(fullPath).catch(() => {});
                        } else {
                            const conversion = convertFileToJson(fullPath);
                            const jsonFullPath = path.join(FILES_DIR, conversion.jsonFile);
                            sendJsonToSupabase(jsonFullPath).catch(() => {});
                        }
                    }
                } catch (e) {
                    console.error('Auto-convert error:', e.message);
                } finally {
                    busy = false;
                }
            }, 1000);
        });
    } catch (e) {
        console.error('Failed to start files watcher:', e.message);
    }
}

async function sendJsonToSupabase(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8') || '{}';
        let payload;
        try { payload = JSON.parse(raw); } catch { payload = { raw }; }
        const headers = { 'Content-Type': 'application/json' };
        if (SUPABASE_FUNCTION_KEY) headers['Authorization'] = `Bearer ${SUPABASE_FUNCTION_KEY}`;
        const res = await fetch(SUPABASE_FUNCTION_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        const ok = res.ok;
        let info = null;
        try { info = await res.text(); } catch {}
        if (!ok) {
            console.error(`Supabase POST failed (${res.status}): ${info || 'no body'}`);
        } else {
            console.log(`Supabase POST success for ${path.basename(filePath)} (${res.status})`);
        }
    } catch (err) {
        console.error('Supabase POST error:', err.message);
    }
}

function loadInvoicesFromFiles() {
    const invoices = [];
    if (fs.existsSync(FILES_DIR)) {
        try {
            const entries = fs.readdirSync(FILES_DIR);
            for (const name of entries) {
                if (!name.toLowerCase().endsWith('.json')) continue;
                const fullPath = path.join(FILES_DIR, name);
                let data;
                try {
                    const stat = fs.statSync(fullPath);
                    if (!stat.isFile()) continue;
                    const raw = fs.readFileSync(fullPath, 'utf8') || '{}';
                    data = JSON.parse(raw);
                } catch (e) {
                    console.error('Error reading file JSON:', name, e.message);
                    continue;
                }

                if (data && data.type === 'excel' && Array.isArray(data.sheets)) {
                    const byNF = {};
                    data.sheets.forEach(sheet => {
                        const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
                        rows.forEach(row => {
                            if (!row) return;
                            let nfNumber = row['Nº Nota'] || row['NF'] || row['Nota'] || row['Numero NF'] || row['Número NF'];
                            if (!nfNumber) return;
                            nfNumber = String(nfNumber).trim();
                            if (!nfNumber) return;
                            if (!byNF[nfNumber]) {
                                byNF[nfNumber] = {
                                    nf: nfNumber,
                                    numeroNF: nfNumber,
                                    empresa: row['Emp.'] || row['Empresa'] || null,
                                    serie: row['Série'] || row['Serie'] || null,
                                    data: row['Data'] || null,
                                    emissao: row['Emissão'] || row['Emissao'] || null,
                                    fornecedor: row['Fornecedor'] || null,
                                    origemOperacao: row['Origem Operação'] || row['Origem Operacao'] || null,
                                    items: []
                                };
                            }
                            byNF[nfNumber].items.push({
                                codigoProduto: row['Cód. Produto'] || row['Codigo Produto'] || null,
                                produto: row['Produto'] || null,
                                valor: row['Valor'] || null,
                                quantidade: row['Qtd.'] || row['Quantidade'] || null,
                                valorTotal: row['Valor Total'] || null,
                                valorLiquido: row['Valor Líquido'] || null,
                                icms: row['ICMS'] || null,
                                icmsSubst: row['ICMS Subst.'] || null,
                                pis: row['PIS'] || null,
                                pisSubst: row['PIS Subst.'] || null,
                                cofins: row['COFINS'] || null,
                                cofinsSubst: row['COFINS Subst.'] || null,
                                ipi: row['IPI'] || null,
                                frete: row['Frete'] || null,
                                seguro: row['Seguro'] || null,
                                custo: row['Custo'] || null,
                                grupoEstoque: row['Grupo Estoque'] || null,
                                subGrupoEstoque: row['Sub Grupo Estoque'] || null,
                                operacaoInterna: row['Operação Interna'] || row['Operacao Interna'] || null,
                                situacao: row['Situação'] || row['Situacao'] || null
                            });
                        });
                    });
                    Object.values(byNF).forEach(inv => invoices.push(inv));
                } else if (data && data.type === 'csv' && Array.isArray(data.rows)) {
                    const rows = data.rows;
                    if (rows.length) {
                        const keys = Object.keys(rows[0]);
                        const nfCandidates = ['nº nota', 'nf', 'nota', 'numero nf', 'número nf'];
                        const nfKey = keys.find(k => nfCandidates.some(c => k.toLowerCase().includes(c)));
                        if (nfKey) {
                            const byNF = {};
                            rows.forEach(row => {
                                if (!row) return;
                                let nfNumber = row[nfKey];
                                if (!nfNumber) return;
                                nfNumber = String(nfNumber).trim();
                                if (!nfNumber) return;
                                if (!byNF[nfNumber]) {
                                    byNF[nfNumber] = {
                                        nf: nfNumber,
                                        numeroNF: nfNumber,
                                        items: []
                                    };
                                }
                                byNF[nfNumber].items.push(row);
                            });
                            Object.values(byNF).forEach(inv => invoices.push(inv));
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error listing FILES_DIR JSON:', e.message);
        }
    }

    return invoices;
}

// Get all actions
app.get('/api/actions', (req, res) => {
    try {
        const data = fs.readFileSync(COORDINATES_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read coordinates file' });
    }
});

// Save all actions
app.post('/api/actions', (req, res) => {
    try {
        const actions = req.body;
        fs.writeFileSync(COORDINATES_FILE, JSON.stringify(actions, null, 4));
        res.json({ success: true, message: 'Actions saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save coordinates file' });
    }
});

// Start Bot
app.post('/api/bot/start', (req, res) => {
    if (botProcess) {
        return res.status(400).json({ error: 'Bot is already running' });
    }

    console.log('Starting bot...');
    botProcess = spawn('node', ['bot_visual.js'], {
        cwd: __dirname,
        shell: true
    });

    botProcess.stdout.on('data', (data) => {
        console.log(`[BOT]: ${data}`);
    });

    botProcess.stderr.on('data', (data) => {
        console.error(`[BOT ERROR]: ${data}`);
    });

    botProcess.on('close', (code) => {
        console.log(`Bot process exited with code ${code}`);
        botProcess = null;
    });

    res.json({ success: true, message: 'Bot started' });
});

// Stop Bot
app.post('/api/bot/stop', (req, res) => {
    if (!botProcess) {
        return res.status(400).json({ error: 'Bot is not running' });
    }

    console.log(`Stopping bot (PID: ${botProcess.pid})...`);
    
    // Kill specific process tree based on PID
    exec(`taskkill /pid ${botProcess.pid} /T /F`, (err, stdout, stderr) => {
        if (err) {
            console.error('Error killing process:', err);
            // Fallback
            botProcess.kill();
        }
        botProcess = null;
        res.json({ success: true, message: 'Bot stopped' });
    });
});

// Restart Bot
app.post('/api/bot/restart', (req, res) => {
    const startBot = () => {
        console.log('Restarting bot...');
        botProcess = spawn('node', ['bot_visual.js'], {
            cwd: __dirname,
            shell: true
        });

        botProcess.stdout.on('data', (data) => {
            console.log(`[BOT]: ${data}`);
        });

        botProcess.stderr.on('data', (data) => {
            console.error(`[BOT ERROR]: ${data}`);
        });

        botProcess.on('close', (code) => {
            console.log(`Bot process exited with code ${code}`);
            botProcess = null;
        });
        
        res.json({ success: true, message: 'Bot restarted' });
    };

    if (botProcess) {
        console.log(`Stopping bot for restart (PID: ${botProcess.pid})...`);
        exec(`taskkill /pid ${botProcess.pid} /T /F`, (err) => {
            if (err) console.error('Error killing process during restart:', err);
            botProcess = null;
            // Wait a bit to ensure files are released
            setTimeout(startBot, 1000);
        });
    } else {
        startBot();
    }
});

// Get Bot Status
app.get('/api/bot/status', (req, res) => {
    res.json({ running: !!botProcess });
});

app.get('/api/files/last', (req, res) => {
    try {
        if (!fs.existsSync(FILES_DIR)) {
            return res.status(404).json({ error: 'Files directory not found' });
        }
        const entries = fs.readdirSync(FILES_DIR);
        const files = entries
            .map(name => {
                const fullPath = path.join(FILES_DIR, name);
                const stat = fs.statSync(fullPath);
                return stat.isFile() ? { name, fullPath, mtime: stat.mtime, size: stat.size } : null;
            })
            .filter(Boolean);
        if (!files.length) {
            return res.status(404).json({ error: 'No files found' });
        }
        files.sort((a, b) => b.mtime - a.mtime);
        const last = files[0];
        res.json({
            filename: last.name,
            size: last.size,
            modifiedAt: last.mtime,
            downloadUrl: `/api/files/${encodeURIComponent(last.name)}`
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read files directory' });
    }
});

app.get('/api/files/:name', (req, res) => {
    try {
        const name = req.params.name;
        const filePath = path.join(FILES_DIR, name);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return res.status(404).json({ error: 'File not found' });
        }
        res.sendFile(filePath);
    } catch (err) {
        res.status(500).json({ error: 'Failed to send file' });
    }
});

app.get('/api/files/last/json', (req, res) => {
    try {
        const lastJson = getLastFileEntry(FILES_DIR, (name) => name.toLowerCase().endsWith('.json'));
        if (!lastJson) {
            return res.status(404).json({ error: 'No JSON file found' });
        }
        const raw = fs.readFileSync(lastJson.fullPath, 'utf8') || '{}';
        const data = JSON.parse(raw);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read last JSON', message: err.message });
    }
});

app.get('/api/files/convert-last', (req, res) => {
    try {
        if (!fs.existsSync(FILES_DIR)) {
            return res.status(404).json({ error: 'Files directory not found' });
        }
        const lastNonJson = getLastFileEntry(FILES_DIR, (name) => !name.toLowerCase().endsWith('.json'));
        if (!lastNonJson) {
            return res.status(404).json({ error: 'No convertible file found' });
        }
        const srcPath = lastNonJson.fullPath;
        const conversion = convertFileToJson(srcPath);
        const result = conversion.result;
        res.json({
            success: true,
            jsonFile: conversion.jsonFile,
            size: conversion.size,
            details: result.type === 'excel'
                ? { sheetsCount: result.sheets.length, rowsTotal: result.sheets.reduce((a, s) => a + s.rows.length, 0) }
                : { rowsCount: (result.rows || []).length }
        });
    } catch (err) {
        res.status(500).json({ error: 'Conversion failed', message: err.message });
    }
});

app.get('/api/invoices', (req, res) => {
    try {
        let invoices = loadInvoicesFromFiles();
        const filters = req.query || {};
        const filterKeys = Object.keys(filters);
        if (filterKeys.length > 0) {
            invoices = invoices.filter(inv => {
                return filterKeys.every(key => {
                    const value = String(filters[key] || '').toLowerCase();
                    if (!value) return true;
                    if (key === 'q') {
                        const fields = [];
                        if (inv.numeroNF != null) fields.push(inv.numeroNF);
                        if (inv.nf != null) fields.push(inv.nf);
                        if (inv.chaveAcesso != null) fields.push(inv.chaveAcesso);
                        if (inv.accessKey != null) fields.push(inv.accessKey);
                        if (Array.isArray(inv.itens)) {
                            inv.itens.forEach(i => {
                                Object.values(i || {}).forEach(v => fields.push(v));
                            });
                        }
                        if (Array.isArray(inv.products)) {
                            inv.products.forEach(p => {
                                Object.values(p || {}).forEach(v => fields.push(v));
                            });
                        }
                        if (Array.isArray(inv.items)) {
                            inv.items.forEach(i => {
                                Object.values(i || {}).forEach(v => fields.push(v));
                            });
                        }
                        return fields.some(f => f != null && String(f).toLowerCase().includes(value));
                    }
                    const direct = inv[key];
                    const directMatch = direct != null && String(direct).toLowerCase().includes(value);
                    if (directMatch) return true;
                    let nestedMatch = false;
                    if (Array.isArray(inv.itens)) {
                        for (const item of inv.itens) {
                            if (item && Object.prototype.hasOwnProperty.call(item, key)) {
                                const v = item[key];
                                if (v != null && String(v).toLowerCase().includes(value)) {
                                    nestedMatch = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (nestedMatch) return true;
                    if (Array.isArray(inv.products)) {
                        for (const p of inv.products) {
                            if (p && Object.prototype.hasOwnProperty.call(p, key)) {
                                const v = p[key];
                                if (v != null && String(v).toLowerCase().includes(value)) {
                                    nestedMatch = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (nestedMatch) return true;
                    if (Array.isArray(inv.items)) {
                        for (const item of inv.items) {
                            if (item && Object.prototype.hasOwnProperty.call(item, key)) {
                                const v = item[key];
                                if (v != null && String(v).toLowerCase().includes(value)) {
                                    nestedMatch = true;
                                    break;
                                }
                            }
                        }
                    }
                    return nestedMatch;
                });
            });
        }
        res.json(invoices);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read invoice data' });
    }
});

app.get('/api/invoices/:nf', (req, res) => {
    const nfParam = String(req.params.nf || '').trim();
    if (!nfParam) {
        return res.status(400).json({ error: 'NF parameter is required' });
    }
    try {
        const invoices = loadInvoicesFromFiles();
        const found = invoices.find(inv => {
            const nf1 = inv.numeroNF != null ? String(inv.numeroNF).trim() : null;
            const nf2 = inv.nf != null ? String(inv.nf).trim() : null;
            return nfParam === nf1 || nfParam === nf2;
        });
        if (!found) {
            return res.status(404).json({ error: 'Invoice not found' });
        }
        res.json(found);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read invoice', message: err.message });
    }
});

app.get('/api/invoices/:nf/items', (req, res) => {
    const nfParam = String(req.params.nf || '').trim();
    if (!nfParam) {
        return res.status(400).json({ error: 'NF parameter is required' });
    }
    try {
        const invoices = loadInvoicesFromFiles();
        const found = invoices.find(inv => {
            const nf1 = inv.numeroNF != null ? String(inv.numeroNF).trim() : null;
            const nf2 = inv.nf != null ? String(inv.nf).trim() : null;
            return nfParam === nf1 || nfParam === nf2;
        });
        if (!found) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        res.json({
            nf: found.nf || nfParam,
            numeroNF: found.numeroNF || nfParam,
            chaveAcesso: found.chaveAcesso || found.accessKey || null,
            itens: Array.isArray(found.itens)
                ? found.itens
                : Array.isArray(found.items)
                    ? found.items
                    : [],
            products: Array.isArray(found.products) ? found.products : []
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read invoice items' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    startFilesWatcher();
});
