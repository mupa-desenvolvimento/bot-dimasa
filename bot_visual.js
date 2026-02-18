const { chromium } = require('playwright');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const sharp = require('sharp');
const clipboardy = require('clipboardy');

function __loadEnv(p) {
    try {
        const envPath = path.resolve(__dirname, p || '.env');
        if (fs.existsSync(envPath)) {
            const txt = fs.readFileSync(envPath, 'utf8');
            txt.split(/\r?\n/).forEach(line => {
                const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
                if (!m) return;
                let v = m[2];
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
                if (!(m[1] in process.env)) process.env[m[1]] = v;
            });
        }
    } catch (e) {}
}
__loadEnv('.env');

// Configuration
const CONFIG = {
    url_inicial: 'https://workspace.sisand.com.br/login',
    credentials: {
        user: '089.jeanp',
        pass: 'Ja152016@'
    },
};

class VisionBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.worker = null;
        this.scaleFactor = 1;
        
        // Control State
        this.isPaused = false;
        this.jumpToStep = null;
        this.currentLoopSteps = null; // Reference to current steps array
        this.currentCoordsObject = null; // Reference to full coords object
        this.isRecording = false;
        this.recordedActions = [];
    }

    async setupControlFunctions(targetPage) {
        if (!targetPage) return;
        
        // Helper to safely expose function (ignores if already exists)
        const safeExpose = async (name, fn) => {
            try {
                await targetPage.exposeFunction(name, fn);
            } catch (e) {
                // Function might already be exposed or page closed
            }
        };

        await safeExpose('control_pause', () => {
            this.isPaused = true;
            this.log('Bot PAUSED by user.');
        });
        
        await safeExpose('control_resume', () => {
            this.isPaused = false;
            this.log('Bot RESUMED by user.');
        });

        await safeExpose('control_jump_step', (index) => {
            this.jumpToStep = parseInt(index);
            this.log(`Jumping to step ${index}...`);
        });

        await safeExpose('control_update_step', (index, x, y, width, height) => {
            if (this.currentLoopSteps && this.currentLoopSteps[index]) {
                const step = this.currentLoopSteps[index];
                step.x = parseInt(x);
                step.y = parseInt(y);
                if (width !== undefined && width !== null && width !== '') {
                    step.width = parseInt(width);
                }
                if (height !== undefined && height !== null && height !== '') {
                    step.height = parseInt(height);
                }
                this.log(`Updated Step ${index} to (${step.x}, ${step.y}, ${step.width || 'w?'}, ${step.height || 'h?'})`);
            }
        });
 
         await safeExpose('control_update_and_save', (index, x, y, width, height) => {
             if (this.currentLoopSteps && this.currentLoopSteps[index]) {
                 const step = this.currentLoopSteps[index];
                 step.x = parseInt(x);
                 step.y = parseInt(y);
                 if (width !== undefined && width !== null && width !== '') {
                     step.width = parseInt(width);
                 }
                 if (height !== undefined && height !== null && height !== '') {
                     step.height = parseInt(height);
                 }
                 this.log(`Updated Step ${index} to (${step.x}, ${step.y}, ${step.width || 'w?'}, ${step.height || 'h?'})`);
             }
             if (this.currentCoordsObject) {
                 fs.writeFileSync('coordinates.json', JSON.stringify(this.currentCoordsObject, null, 2));
                 this.log('coordinates.json SAVED!');
             }
         });

        await safeExpose('control_save_coords', () => {
            if (this.currentCoordsObject) {
                fs.writeFileSync('coordinates.json', JSON.stringify(this.currentCoordsObject, null, 2));
                this.log('coordinates.json SAVED!');
            }
        });

        await safeExpose('control_test_click', async (x, y) => {
            await this.visualClick(parseInt(x), parseInt(y));
        });

        await safeExpose('control_record_action', async (isRecording) => {
            if (isRecording) {
                this.isRecording = true;
                this.recordedActions = [];
                this.log('🔴 Modo gravação ATIVADO (todas as ações serão registradas).');
                try { await this.updateRecordingUI(true); } catch(e) {}
            } else {
                this.isRecording = false;
                const all = this.recordedActions || [];
                const setupActions = all.filter(a => a.kind === 'bot_step' && !a.is_loop);
                const loopActions = all.filter(a => a.kind === 'bot_step' && a.is_loop);
                const userEvents = all.filter(a => a.kind === 'user_event');

                const payload = {
                    metadata: {
                        saved_at: new Date().toISOString(),
                        total_events: all.length,
                        total_bot_steps_setup: setupActions.length,
                        total_bot_steps_loop: loopActions.length,
                        total_user_events: userEvents.length
                    },
                    setup_actions: setupActions,
                    loop_actions: loopActions,
                    user_events: userEvents
                };

                this.log(`⏹️ Modo gravação DESATIVADO. Salvando ${all.length} registros unificados...`);
                try {
                    fs.writeFileSync('recorded_actions.json', JSON.stringify(payload, null, 2));
                    this.log('✅ Gravação unificada salva em recorded_actions.json');
                } catch (e) {
                    this.log(`❌ Erro ao salvar gravação: ${e.message}`);
                }
                try { await this.updateRecordingUI(false); } catch(e) {}
            }
        });

        await safeExpose('control_push_recorded_action', (event) => {
            if (!this.isRecording) return;
            const entry = {
                kind: 'user_event',
                ...event
            };
            if (event.type === 'keypress') {
                const mods = [];
                if (event.ctrlKey) mods.push('Ctrl');
                if (event.altKey) mods.push('Alt');
                if (event.shiftKey) mods.push('Shift');
                const keyName = event.key;
                entry.description = `Tecla: ${mods.concat(keyName).join('+')}`;
            }
            this.recordedActions.push(entry);
            this.updateRecordingDisplay().catch(() => {});
        });

        await safeExpose('control_test_recorded_action', async (index) => {
            await this.testRecordedAction(parseInt(index));
        });

        await safeExpose('control_add_print_action', async () => {
            await this.addPrintAction();
        });

        await safeExpose('control_start_ocr_region', async () => {
            await this.startOCRRegionSelection();
        });

        await safeExpose('control_ocr_region_selected', async ({x, y, width, height}) => {
            await this.addOCRRegionAction(x, y, width, height);
        });

        await safeExpose('control_delete_recorded_action', (index) => {
            const idx = parseInt(index);
            if (!this.recordedActions || idx < 0 || idx >= this.recordedActions.length) return;
            this.recordedActions.splice(idx, 1);
            this.updateRecordingDisplay().catch(() => {});
        });
    }

    async init() {
        // Clear debug log
        try { fs.writeFileSync('debug_log.txt', ''); } catch (e) {}

        console.log('Initializing VisionBot...');
        this.browser = await chromium.launch({
            headless: false,
            args: ['--start-maximized']
        });
        
        this.scaleFactor = 2; // High DPI for better OCR
        const context = await this.browser.newContext({
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: this.scaleFactor
        });
        this.page = await context.newPage();
        
        // --- EXPOSE CONTROL FUNCTIONS TO BROWSER ---
        await this.setupControlFunctions(this.page);
        // -------------------------------------------
        
        console.log('Initializing Tesseract worker...');
        this.worker = await Tesseract.createWorker('por');
    }

    async log(message) {
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] ${message}`;
        console.log(logMsg);
        try {
            fs.appendFileSync('debug_log.txt', logMsg + '\n');
        } catch (e) {
            // ignore file error
        }
    }

    async delay(ms) {
        let remaining = ms;
        while (remaining > 0) {
            // Handle Pause
            while (this.isPaused) {
                await new Promise(r => setTimeout(r, 200));
                // Allow breaking out if jump is requested
                if (this.jumpToStep !== null) return;
            }

            // Handle Jump (Break early)
            if (this.jumpToStep !== null) return;

            // Sleep in small chunks to remain responsive
            const chunk = Math.min(remaining, 100);
            await new Promise(r => setTimeout(r, chunk));
            remaining -= chunk;
        }
    }

    async updateRecordingUI(isRecording) {
        try {
            await this.page.evaluate((recording) => {
                const overlay = document.getElementById('bot-overlay');
                if (!overlay) return;
                const existing = document.getElementById('recording-panel');
                if (existing) existing.remove();

                if (recording) {
                    const recPanel = document.createElement('div');
                    recPanel.id = 'recording-panel';
                    recPanel.style.cssText = 'margin-top:10px; padding:10px; background:rgba(255,0,0,0.1); border:1px solid #ff4444; border-radius:6px;';
                    recPanel.innerHTML = `
                        <div style="display:flex; gap:6px; margin-bottom:8px;">
                            <button id="btn-add-print" style="flex:1; background:#6c757d; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">🖼️ Adicionar Print</button>
                            <button id="btn-ocr-region" style="flex:1; background:#007bff; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">🔎 Selecionar Região OCR</button>
                        </div>
                        <div id="recording-display"></div>
                    `;
                    overlay.appendChild(recPanel);
                    const btnPrint = recPanel.querySelector('#btn-add-print');
                    const btnOCR = recPanel.querySelector('#btn-ocr-region');
                    if (btnPrint) btnPrint.addEventListener('click', () => {
                        if (window.control_add_print_action) window.control_add_print_action();
                    });
                    if (btnOCR) btnOCR.addEventListener('click', () => {
                        if (window.control_start_ocr_region) window.control_start_ocr_region();
                    });
                }
            }, isRecording);
            if (isRecording) await this.updateRecordingDisplay();
        } catch (e) {}
    }

    async updateRecordingDisplay() {
        if (!this.isRecording) return;
        try {
            const actions = this.recordedActions.slice();
            await this.page.evaluate((actions) => {
                const display = document.getElementById('recording-display');
                if (!display) return;
                const limit = 20;
                const base = Math.max(0, actions.length - limit);
                const recent = actions.slice(-limit);
                let html = '<div style="max-height:220px; overflow-y:auto; font-size:11px;">';
                recent.forEach((action, idx) => {
                    const absIdx = base + idx;
                    const time = action.timestamp != null ? (typeof action.timestamp === 'number' ? (action.timestamp/1000).toFixed(1)+'s' : '') : '';
                    const label = action.description || action.action || action.type || 'action';
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:6px; padding:4px; border-bottom:1px solid #333;">
                        <div style="flex:1;">
                            <strong>${time ? time : ''}</strong> ${label}
                        </div>
                        <div style="display:flex; gap:4px;">
                            <button data-idx="${absIdx}" class="rec-test" style="background:#17a2b8; color:#fff; border:none; padding:3px 6px; border-radius:3px; cursor:pointer;">▶ Testar</button>
                            <button data-idx="${absIdx}" class="rec-delete" style="background:#dc3545; color:#fff; border:none; padding:3px 6px; border-radius:3px; cursor:pointer;">🗑</button>
                        </div>
                    </div>`;
                });
                html += '</div>';
                display.innerHTML = html;

                display.querySelectorAll('.rec-test').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idx = parseInt(e.currentTarget.getAttribute('data-idx'));
                        if (window.control_test_recorded_action) window.control_test_recorded_action(idx);
                    });
                });
                display.querySelectorAll('.rec-delete').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idx = parseInt(e.currentTarget.getAttribute('data-idx'));
                        if (window.control_delete_recorded_action) window.control_delete_recorded_action(idx);
                    });
                });
            }, actions);
        } catch (e) {}
    }

    async addPrintAction() {
        try {
            if (!fs.existsSync('prints')) {
                try { fs.mkdirSync('prints', { recursive: true }); } catch (e) {}
            }
            const filename = `prints/rec_${Date.now()}.png`;
            await this.page.screenshot({ path: filename });
            const entry = {
                kind: 'bot_step',
                phase: 'unknown',
                is_loop: false,
                index: null,
                description: `Screenshot salvo: ${path.basename(filename)}`,
                action: 'screenshot',
                filename,
                timestamp: Date.now()
            };
            if (this.isRecording) this.recordedActions.push(entry);
            await this.updateRecordingDisplay();
            this.log(`Screenshot salvo em ${filename}`);
        } catch (e) {
            this.log(`Erro ao capturar print: ${e.message}`);
        }
    }

    async startOCRRegionSelection() {
        try {
            await this.page.evaluate(() => {
                if (document.getElementById('ocr-select-overlay')) return;
                const overlay = document.createElement('div');
                overlay.id = 'ocr-select-overlay';
                overlay.style.cssText = 'position:fixed; inset:0; z-index:99999998; cursor:crosshair;';
                document.body.appendChild(overlay);

                const box = document.createElement('div');
                box.id = 'ocr-select-box';
                box.style.cssText = 'position:fixed; border:2px dashed #00e5ff; background:rgba(0,229,255,0.1); pointer-events:none;';
                document.body.appendChild(box);

                let startX=0, startY=0, dragging=false;
                const onDown = (e) => { startX = e.clientX; startY = e.clientY; dragging = true; };
                const onMove = (e) => {
                    if (!dragging) return;
                    const x = Math.min(startX, e.clientX);
                    const y = Math.min(startY, e.clientY);
                    const w = Math.abs(e.clientX - startX);
                    const h = Math.abs(e.clientY - startY);
                    box.style.left = x + 'px'; box.style.top = y + 'px';
                    box.style.width = w + 'px'; box.style.height = h + 'px';
                };
                const onUp = (e) => {
                    dragging = false;
                    const x = parseInt(box.style.left || '0');
                    const y = parseInt(box.style.top || '0');
                    const w = parseInt(box.style.width || '0');
                    const h = parseInt(box.style.height || '0');
                    overlay.removeEventListener('mousedown', onDown, true);
                    overlay.removeEventListener('mousemove', onMove, true);
                    overlay.removeEventListener('mouseup', onUp, true);
                    overlay.remove();
                    box.remove();
                    if (w > 5 && h > 5 && window.control_ocr_region_selected) {
                        window.control_ocr_region_selected({ x, y, width: w, height: h });
                    }
                };

                overlay.addEventListener('mousedown', onDown, true);
                overlay.addEventListener('mousemove', onMove, true);
                overlay.addEventListener('mouseup', onUp, true);
            });
        } catch (e) {
            this.log(`Erro ao iniciar seleção OCR: ${e.message}`);
        }
    }

    async addOCRRegionAction(x, y, width, height) {
        try {
            const entry = {
                kind: 'bot_step',
                phase: 'unknown',
                is_loop: false,
                index: null,
                description: `OCR região [${x}, ${y}, ${width}, ${height}]`,
                action: 'ocr_region',
                x, y, width, height,
                timestamp: Date.now()
            };
            if (this.isRecording) this.recordedActions.push(entry);

            // Run OCR test now
            const text = await this.getTextInRegion({ x, y, width, height }, '6');
            if (!fs.existsSync('prints')) {
                try { fs.mkdirSync('prints', { recursive: true }); } catch (e) {}
            }
            const out = `prints/ocr_test_${Date.now()}.txt`;
            fs.writeFileSync(out, text);
            this.log(`OCR teste salvo em ${out}`);
            await this.updateRecordingDisplay();
        } catch (e) {
            this.log(`Erro ao adicionar OCR de região: ${e.message}`);
        }
    }

    async testRecordedAction(index) {
        try {
            const a = this.recordedActions[index];
            if (!a) return;
            if (a.kind === 'bot_step') {
                const step = { action: a.action, x: a.x, y: a.y, startX: a.startX, startY: a.startY, endX: a.endX, endY: a.endY, deltaY: a.deltaY, width: a.width, height: a.height, description: a.description, wait_before: 0, wait_after: 0, text: a.text };
                const ctx = { __phase: a.is_loop ? 'loop' : 'setup', nf: a.nf || '' };
                await this.executeStep(step, ctx);
            } else if (a.kind === 'user_event') {
                switch (a.type) {
                    case 'click':
                        await this.visualClick(a.x, a.y);
                        break;
                    case 'double_click':
                        await this.visualClick(a.x, a.y, { doubleClick: true });
                        break;
                    case 'scroll':
                        await this.page.mouse.move(a.x || 500, a.y || 500);
                        await this.page.mouse.wheel(0, a.deltaY || 200);
                        break;
                    case 'typing':
                        if (a.char) await this.page.keyboard.type(a.char);
                        break;
                    case 'keypress':
                        if (a.key) await this.page.keyboard.press(a.key);
                        break;
                }
            }
        } catch (e) {
            this.log(`Erro ao testar ação #${index}: ${e.message}`);
        }
    }

    async captureAndScan(region = null) {
        const screenshotOptions = {};
        if (region) {
            screenshotOptions.clip = region;
        }

        const screenshotBuffer = await this.page.screenshot(screenshotOptions);
        fs.writeFileSync('debug_ocr_capture.png', screenshotBuffer);

        const { data } = await this.worker.recognize(screenshotBuffer);
        
        const words = [];
        if (data.blocks) {
            for (const block of data.blocks) {
                if (block.paragraphs) {
                    for (const paragraph of block.paragraphs) {
                        if (paragraph.lines) {
                            for (const line of paragraph.lines) {
                                if (line.words) {
                                    const adjustedWords = line.words.map(w => {
                                        if (region) {
                                            return {
                                                ...w,
                                                bbox: {
                                                    x0: (w.bbox.x0 / this.scaleFactor) + region.x,
                                                    y0: (w.bbox.y0 / this.scaleFactor) + region.y,
                                                    x1: (w.bbox.x1 / this.scaleFactor) + region.x,
                                                    y1: (w.bbox.y1 / this.scaleFactor) + region.y
                                                }
                                            };
                                        }
                                        return w;
                                    });
                                    words.push(...adjustedWords);
                                }
                            }
                        }
                    }
                }
            }
        }
        return words;
    }

    async findElementByText(targetText, options = {}) {
        const { exact = false, caseSensitive = false, region = null } = options;
        const words = await this.captureAndScan(region);
        
        const normalize = (str) => caseSensitive ? str : str.toLowerCase();
        const target = normalize(targetText);
        const targetWords = target.split(/\s+/);
        
        for (let i = 0; i < words.length; i++) {
            let match = true;
            for (let j = 0; j < targetWords.length; j++) {
                if (i + j >= words.length) {
                    match = false;
                    break;
                }
                const wordText = normalize(words[i + j].text);
                const cleanWord = wordText.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
                
                if (exact) {
                    if (cleanWord !== targetWords[j]) match = false;
                } else {
                    if (!cleanWord.includes(targetWords[j])) match = false;
                }
            }

            if (match) {
                const firstWord = words[i];
                const lastWord = words[i + targetWords.length - 1];
                
                return {
                    x: firstWord.bbox.x0,
                    y: firstWord.bbox.y0,
                    width: lastWord.bbox.x1 - firstWord.bbox.x0,
                    height: lastWord.bbox.y1 - firstWord.bbox.y0,
                    text: targetText
                };
            }
        }
        return null;
    }

    async clickText(text, options = {}) {
        this.log(`Searching visually for '${text}'...`);
        const maxRetries = options.retries || 10;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const element = await this.findElementByText(text, options);
            if (element) {
                this.log(`'${text}' found at (${element.x}, ${element.y}). Clicking...`);
                const clickX = element.x + element.width / 2;
                const clickY = element.y + element.height / 2;
                
                await this.page.mouse.move(clickX, clickY);
                await this.delay(500);
                if (options.doubleClick) {
                    await this.page.mouse.dblclick(clickX, clickY);
                } else {
                    await this.page.mouse.click(clickX, clickY);
                }
                return true;
            }
            this.log(`'${text}' not found (Attempt ${attempt}/${maxRetries}). Waiting...`);
            
            if (attempt === maxRetries) {
                const words = await this.captureAndScan();
                const foundTexts = words.map(w => w.text).join(' ');
                this.log(`DEBUG: Available text on screen (first 500 chars): ${foundTexts.substring(0, 500)}...`);
                fs.writeFileSync('ocr_debug.txt', foundTexts);
            }

            await this.delay(5000);
        }
        throw new Error(`Visual element '${text}' not found after ${maxRetries} attempts.`);
    }

    async visualClick(x, y, options = {}) {
        this.log(`Visual Click at (${x}, ${y}) [Double: ${options.doubleClick ? 'Yes' : 'No'}]...`);
        
        await this.page.evaluate(({x, y}) => {
            const dot = document.createElement('div');
            dot.style.position = 'fixed';
            dot.style.left = `${x - 10}px`;
            dot.style.top = `${y - 10}px`;
            dot.style.width = '20px';
            dot.style.height = '20px';
            dot.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
            dot.style.borderRadius = '50%';
            dot.style.border = '2px solid white';
            dot.style.zIndex = '999999';
            dot.style.pointerEvents = 'none';
            dot.style.boxShadow = '0 0 10px rgba(255,0,0,0.8)';
            dot.style.transition = 'opacity 0.5s';
            document.body.appendChild(dot);
            
            // Remove after animation
            setTimeout(() => {
                dot.style.opacity = '0';
                setTimeout(() => dot.remove(), 500);
            }, 1000);
        }, { x, y });

        try {
            await this.page.mouse.move(x, y);
            await this.delay(500);
            
            if (options.doubleClick) {
                await this.page.mouse.dblclick(x, y);
            } else {
                await this.page.mouse.down({ button: 'left' });
                await this.delay(100);
                await this.page.mouse.up({ button: 'left' });
            }
            
            this.log(`Click executed at (${x}, ${y})`);
        } catch (error) {
            this.log(`Failed to click at (${x}, ${y}): ${error.message}`);
            throw error;
        }
    }

    async getWordsInRegion(region, psm = '3') {
        await this.worker.setParameters({
            tessedit_pageseg_mode: psm,
        });

        // Hide overlay elements to avoid contaminating OCR screenshot
        await this.page.evaluate(() => {
            const ids = ['bot-overlay', 'bot-highlight-box', 'bot-drag-container'];
            window.__botPrevDisplayOCR = {};
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    window.__botPrevDisplayOCR[id] = el.style.display;
                    el.style.display = 'none';
                }
            });
        });
        await this.delay(30);

        const screenshotBuffer = await this.page.screenshot({ clip: region });
        fs.writeFileSync('debug_last_ocr_raw.png', screenshotBuffer);

        let processedBuffer = screenshotBuffer;
        try {
            const image = await Jimp.read(screenshotBuffer);
            image
                .greyscale()
                .contrast(0.8)
                .posterize(2)
                .normalize();
            
            processedBuffer = await image.getBuffer('image/png');
            fs.writeFileSync('debug_last_ocr_processed.png', processedBuffer);
            this.log(`[getWordsInRegion] Image preprocessed (Greyscale+HighContrast+B/W)`);
        } catch (e) {
            this.log(`[getWordsInRegion] Preprocessing failed: ${e.message}. Using raw image.`);
        }

        const { data } = await this.worker.recognize(processedBuffer);

        // Restore overlay elements
        await this.page.evaluate(() => {
            const ids = ['bot-overlay', 'bot-highlight-box', 'bot-drag-container'];
            if (window.__botPrevDisplayOCR) {
                ids.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) {
                        el.style.display = window.__botPrevDisplayOCR[id] ?? '';
                    }
                });
            } else {
                ids.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.style.display = '';
                });
            }
        });
        
        this.log(`[getWordsInRegion] PSM=${psm}, Text Length=${data.text.length}`);
        this.log(`[getWordsInRegion] Text Preview: ${data.text.substring(0, 200).replace(/\n/g, ' ')}...`);
        
        const words = [];
        
        if (data.words && data.words.length > 0) {
            data.words.forEach(w => {
                words.push({
                    text: w.text,
                    confidence: w.confidence,
                    bbox: {
                        x0: (w.bbox.x0 / this.scaleFactor) + region.x,
                        y0: (w.bbox.y0 / this.scaleFactor) + region.y,
                        x1: (w.bbox.x1 / this.scaleFactor) + region.x,
                        y1: (w.bbox.y1 / this.scaleFactor) + region.y
                    }
                });
            });
            return words;
        }

        if (data.blocks) {
            data.blocks.forEach(block => {
                if (block.paragraphs) {
                    block.paragraphs.forEach(para => {
                        if (para.lines) {
                            para.lines.forEach(line => {
                                if (line.words) {
                                    line.words.forEach(w => {
                                        words.push({
                                            text: w.text,
                                            confidence: w.confidence,
                                            bbox: {
                                                x0: (w.bbox.x0 / this.scaleFactor) + region.x,
                                                y0: (w.bbox.y0 / this.scaleFactor) + region.y,
                                                x1: (w.bbox.x1 / this.scaleFactor) + region.x,
                                                y1: (w.bbox.y1 / this.scaleFactor) + region.y
                                            }
                                        });
                                    });
                                }
                            });
                        }
                    });
                }
            });
        }

        return words;
    }

    async getTextInRegion(region, psm = '3') {
        await this.worker.setParameters({
            tessedit_pageseg_mode: psm,
        });

        const screenshotBuffer = await this.page.screenshot({ clip: region });
        const { data } = await this.worker.recognize(screenshotBuffer);
        return data.text.toLowerCase();
    }

    async waitForDetailsScreen(maxRetries = 5) {
        for(let i = 0; i < maxRetries; i++) {
            await this.delay(2000);
            
            // Use raw text for robustness against missing word coordinates
            const headerText = await this.getTextInRegion({ x: 0, y: 0, width: 1920, height: 600 }, '3');
            this.log(`[waitForDetailsScreen] Header Text Preview: ${headerText.substring(0, 200).replace(/\n/g, ' ')}...`);
            
            // NEGATIVE CHECK: If we see List Screen elements, we are NOT in details
            // "nova nota", "deletar", "pesquisa" are on the List Toolbar
            if (headerText.includes("fila de notas") || 
                headerText.includes("em trânsito") || 
                headerText.includes("nova nota") || 
                headerText.includes("pesquisa") ||
                headerText.includes("deletar")) {
                this.log("Still on List Screen (detected List Toolbar keywords).");
                this.log(`Wait attempt ${i+1}/${maxRetries}...`);
                continue; // Retry
            }

            // STRICTER CHECKS: Avoid "entrada" (in list title), "itens" (ambiguous), "nota fiscal" (ambiguous)
            if (headerText.includes("dados da nota") || 
                headerText.includes("emitente") || 
                headerText.includes("destinatário") || 
                headerText.includes("transportador") ||
                headerText.includes("volumes") ||
                headerText.includes("informações adicionais") ||
                headerText.includes("chave de acesso")) {
                this.log("Details screen confirmed.");
                return true;
            }
            this.log(`Wait attempt ${i+1}/${maxRetries}...`);
        }
        return false;
    }

    async closeDetailsScreen() {
        this.log("Attempting to close details screen...");
        
        // Estratégia 1: Buscar botão "Voltar"
        const bottomRegion = { x: 0, y: 800, width: 1920, height: 280 };
        let btn = await this.findElementByText("Voltar", { region: bottomRegion });
        if (btn) {
            this.log("Found 'Voltar' button, clicking...");
            await this.visualClick(btn.x + btn.width/2, btn.y + btn.height/2);
            await this.delay(3000);
            return true;
        }
        
        // Estratégia 2: Buscar botão "Fechar"
        btn = await this.findElementByText("Fechar", { region: bottomRegion });
        if (btn) {
            this.log("Found 'Fechar' button, clicking...");
            await this.visualClick(btn.x + btn.width/2, btn.y + btn.height/2);
            await this.delay(3000);
            return true;
        }
        
        // Estratégia 3: Tecla ESC
        this.log("Buttons not found. Trying ESC key...");
        await this.page.keyboard.press('Escape');
        await this.delay(2000);
        
        return true;
    }

    async extractInvoiceDetails(nfNumber, initialClickX, rowY, skipOpening = false) {
        this.log(`\n╔════════════════════════════════════════════════╗`);
        this.log(`║  Processing Invoice: ${nfNumber ? nfNumber.padEnd(29) : "Unknown".padEnd(29)} ║`);
        this.log(`╚════════════════════════════════════════════════╝`);

        const clickY = rowY;
        let detailsLoaded = skipOpening;

        try {
            if (!skipOpening) {
                // Define X coordinates to try (Center, Left, Right)
                const xPositions = [400, 200, 600, 100, 700];
                if (initialClickX) xPositions.unshift(initialClickX);
                const uniqueX = [...new Set(xPositions)];

                for (const clickX of uniqueX) {
                    this.log(`\n--- Attempting extraction at X=${clickX} ---`);
                    
                    // STRATEGY 1: Double Click
                    this.log(`[STEP 1] Strategy: Double Click at X=${clickX}, Y=${clickY}`);
                    try {
                        await this.page.mouse.click(clickX, clickY, { clickCount: 2 });
                        detailsLoaded = await this.waitForDetailsScreen(3);
                        if (detailsLoaded) {
                            this.log(`✓ Details screen loaded via Double Click at X=${clickX}.`);
                            break;
                        }
                    } catch (e) { this.log(`Error in Double Click: ${e.message}`); }

                    // STRATEGY 2: Select + Enter (Only try once per X, or maybe just once overall? Let's try per X)
                    if (!detailsLoaded) {
                        this.log(`[STEP 2] Strategy: Select + Enter at X=${clickX}`);
                        try {
                            await this.page.mouse.click(clickX, clickY); // Select
                            await this.delay(500);
                            await this.page.keyboard.press('Enter');
                            detailsLoaded = await this.waitForDetailsScreen(3);
                            if (detailsLoaded) {
                                this.log(`✓ Details screen loaded via Enter key at X=${clickX}.`);
                                break;
                            }
                        } catch (e) { this.log(`Error in Select+Enter: ${e.message}`); }
                    }
                }

                // STRATEGY 3: Button (Try only once after all X failed, or maybe if selected?)
                if (!detailsLoaded) {
                    this.log(`[STEP 3] Strategy: Click 'Visualizar' Button (Last Resort)`);
                    try {
                        // Ensure row is selected (click center)
                        await this.page.mouse.click(400, clickY);
                        await this.delay(500);

                        // Find button
                        const btnRegion = { x: 0, y: 0, width: 1920, height: 300 };
                        const btn = await this.findElementByText("Visualizar", { region: btnRegion }) || 
                                    await this.findElementByText("Detalhes", { region: btnRegion }) ||
                                    await this.findElementByText("Nota", { region: btnRegion });

                        if (btn) {
                            this.log(`✓ Found button '${btn.text}' at (${btn.x}, ${btn.y}). Clicking...`);
                            await this.visualClick(btn.x + btn.width/2, btn.y + btn.height/2);
                            detailsLoaded = await this.waitForDetailsScreen(5);
                        } else {
                            this.log(`⚠ Could not find 'Visualizar' button.`);
                        }
                    } catch (e) { this.log(`Error in Button Click: ${e.message}`); }
                }
            }

            if (!detailsLoaded) {
                this.log(`❌ ERROR processing invoice ${nfNumber}: Details screen did not load after all strategies.`);
                await this.page.screenshot({ path: `error_load_${nfNumber}.png` });
                return { error: "Details screen did not load", nf: nfNumber };
            }

            this.log("✓ Details screen loaded successfully");

            // ===== STEP 2: EXTRACT ACCESS KEY =====
            this.log("[STEP 2] Extracting Access Key...");
            
            const topRegion = { x: 0, y: 50, width: 1920, height: 400 };
            const topWords = await this.getWordsInRegion(topRegion, '6');
            
            let accessKey = "";
            for (const w of topWords) {
                const clean = w.text.replace(/\D/g, '');
                if (clean.length === 44) {
                    accessKey = clean;
                    this.log(`✓ Access Key Found: ${accessKey}`);
                    break;
                }
            }
            
            // Tenta extrair número da NF da chave se não foi passado
            if (nfNumber === "Unknown" || !nfNumber) {
                if (accessKey && accessKey.length === 44) {
                    // NF number is usually pos 25 to 34 (9 digits)
                    // Layout: 2 (UF) + 4 (AAMM) + 14 (CNPJ) + 2 (Mod) + 3 (Serie) + 9 (NF) + ...
                    // Indices: 0-1, 2-5, 6-19, 20-21, 22-24, 25-33
                    const extractedNF = accessKey.substring(25, 34);
                    nfNumber = parseInt(extractedNF).toString();
                    this.log(`✓ Extracted NF Number from Key: ${nfNumber}`);
                } else {
                    nfNumber = `Unknown_${Date.now()}`;
                }
            }

            if (!accessKey) {
                this.log("⚠ Access Key not found, using fallback");
                accessKey = `NF_${nfNumber}_${Date.now()}`;
            }

            // ===== STEP 3: NAVIGATE TO ITEMS TAB =====
            this.log("[STEP 3] Navigating to 'Itens' tab...");
            
            const tabRegion = { x: 0, y: 100, width: 1920, height: 500 };
            const itensTab = await this.findElementByText("Itens", { region: tabRegion });
            
            if (!itensTab) {
                throw new Error("'Itens' tab not found");
            }
            
            await this.page.mouse.click(itensTab.x + itensTab.width / 2, itensTab.y + itensTab.height / 2);
            await this.delay(3000); // Wait for tab content to load
            
            // Verify items grid is visible
            const gridCheckRegion = { x: 0, y: 300, width: 1920, height: 200 };
            const gridWords = await this.getWordsInRegion(gridCheckRegion, '3');
            const gridText = gridWords.map(w => w.text).join(' ').toLowerCase();
            
            if (!gridText.includes("codigo") && !gridText.includes("descri") && !gridText.includes("produto")) {
                this.log("⚠ Items grid not clearly visible, but proceeding...");
            } else {
                this.log("✓ Items grid confirmed");
            }

            // ===== STEP 4: EXTRACT ITEMS =====
            this.log("[STEP 4] Extracting Items from table...");
            
            const items = [];
            const tableRegion = { x: 0, y: 450, width: 1920, height: 500 };
            
            // Capture table screenshot for debugging
            await this.page.screenshot({ 
                clip: tableRegion, 
                path: `debug_table_${nfNumber}.png` 
            });
            
            const tableWords = await this.getWordsInRegion(tableRegion, '6');
            
            // Group words by Y coordinate (rows)
            const rowGroups = {};
            const rowTolerance = 12;
            
            tableWords.forEach(w => {
                const yCenter = Math.round((w.bbox.y0 + w.bbox.y1) / 2 / rowTolerance) * rowTolerance;
                if (!rowGroups[yCenter]) rowGroups[yCenter] = [];
                rowGroups[yCenter].push(w);
            });
            
            // Process each row
            let itemOrder = 1;
            Object.keys(rowGroups)
                .map(k => parseInt(k))
                .sort((a, b) => a - b)
                .forEach(yKey => {
                    const rowWords = rowGroups[yKey].sort((a, b) => a.bbox.x0 - b.bbox.x0);
                    const rowText = rowWords.map(w => w.text).join(' ').trim();
                    
                    // Filter out header rows and empty rows
                    if (rowText.length > 10 && 
                        /\d/.test(rowText) && 
                        !rowText.toLowerCase().includes('codigo') &&
                        !rowText.toLowerCase().includes('descri')) {
                        
                        // Try to parse structured data
                        const codigo = rowWords[0] ? rowWords[0].text : "";
                        const descricao = rowWords.slice(1, -2).map(w => w.text).join(' ');
                        const quantidade = rowWords[rowWords.length - 2] ? rowWords[rowWords.length - 2].text : "";
                        const valor = rowWords[rowWords.length - 1] ? rowWords[rowWords.length - 1].text : "";
                        
                        items.push({
                            ordem: itemOrder++,
                            codigo: codigo,
                            descricao: descricao,
                            quantidade: quantidade,
                            valor: valor,
                            linha_completa: rowText
                        });
                    }
                });
            
            this.log(`✓ Extracted ${items.length} items`);

            // ===== STEP 5: SAVE JSON =====
            const invoiceData = {
                nota_fiscal: nfNumber,
                chave_acesso: accessKey,
                total_itens: items.length,
                data_extracao: new Date().toISOString(),
                itens: items
            };

            const fileName = `invoice_${accessKey}.json`;
            fs.writeFileSync(fileName, JSON.stringify(invoiceData, null, 2));
            this.log(`✓ Saved to ${fileName}`);

            // ===== STEP 6: CLOSE AND RETURN =====
            this.log("[STEP 6] Closing details and returning to list...");
            await this.closeDetailsScreen();
            
            // Verify we're back at the list
            await this.delay(2000);
            const listCheckRegion = { x: 0, y: 0, width: 1920, height: 300 };
            const listWords = await this.getWordsInRegion(listCheckRegion, '3');
            const listText = listWords.map(w => w.text).join(' ').toLowerCase();
            
            if (listText.includes('fila') || listText.includes('notas') || listText.includes('lista')) {
                this.log("✓ Successfully returned to list");
            } else {
                this.log("⚠ List screen not confirmed, but continuing...");
            }

            return invoiceData;

        } catch (error) {
            this.log(`❌ ERROR processing invoice ${nfNumber}: ${error.message}`);
            await this.page.screenshot({ path: `error_invoice_${nfNumber}.png` });
            
            // Try to recover
            try {
                await this.closeDetailsScreen();
            } catch (e) {
                this.log(`⚠ Could not close details screen: ${e.message}`);
            }
            
            return {
                nota_fiscal: nfNumber,
                error: error.message,
                status: "failed"
            };
        }
    }

    async extractProductsFromTable(context = {}, regionOverride = null) {
        this.log("Starting product extraction from table...");
        const products = [];
        const tableRegion = regionOverride && typeof regionOverride.x === 'number'
            ? {
                x: regionOverride.x,
                y: regionOverride.y,
                width: regionOverride.width || 350,
                height: regionOverride.height || 350
            }
            : { x: 50, y: 260, width: 350, height: 350 };
        
        // Initial scan
        let previousText = "";
        let retries = 0;
        const maxScrolls = 5;

        for (let i = 0; i < maxScrolls; i++) {
            this.log(`Scanning table (Scroll ${i})...`);
            
            // Capture and process region
            const words = await this.getWordsInRegion(tableRegion, '6'); // PSM 6 for block of text
            
            const rows = {};
            const tolerance = 10;
            
            words.forEach(w => {
                const y = Math.round((w.bbox.y0 + w.bbox.y1) / 2 / tolerance) * tolerance;
                if (!rows[y]) rows[y] = [];
                rows[y].push(w);
            });
            
            Object.keys(rows).sort((a, b) => parseInt(a) - parseInt(b)).forEach(y => {
                const rowWords = rows[y].sort((a, b) => a.bbox.x0 - b.bbox.x0);
                const rowText = rowWords.map(w => w.text).join(' ');
                
                if (rowText.length > 10 && /\d/.test(rowText)) {
                    const code = rowWords[0]?.text || "";

                    let quantityIndex = -1;
                    for (let idx = rowWords.length - 1; idx >= 1; idx--) {
                        const t = rowWords[idx].text.replace(/\s/g, '');
                        if (/^\d+$/.test(t)) {
                            quantityIndex = idx;
                            break;
                        }
                    }
                    if (quantityIndex === -1) {
                        return;
                    }

                    const locEnd = Math.max(1, quantityIndex - 1);
                    const locStart = Math.max(1, locEnd - 3);

                    const descriptionEnd = Math.max(1, locStart - 1);

                    const descriptionWords = rowWords.slice(1, descriptionEnd + 1);
                    const locationWords = rowWords.slice(locStart, locEnd + 1);
                    const quantityWord = rowWords[quantityIndex]?.text || "";

                    const product = {
                        raw: rowText,
                        codigo_barras: code,
                        descricao: descriptionWords.map(w => w.text).join(' ').trim(),
                        localizacao: locationWords.map(w => w.text).join(' ').trim(),
                        quantidade: quantityWord.trim()
                    };
                    
                    if (!products.some(p => p.raw === product.raw)) {
                        products.push(product);
                    }
                }
            });

            // Scroll down
            const currentText = words.map(w => w.text).join('');
            if (currentText === previousText) {
                this.log("End of table reached (content unchanged).");
                break;
            }
            previousText = currentText;

            // Scroll action
            await this.page.mouse.move(tableRegion.x + tableRegion.width / 2, tableRegion.y + tableRegion.height / 2);
            await this.page.mouse.wheel(0, 300);
            await this.delay(1000);
        }
        
        if (products.length === 0) {
            this.log("No structured products found, running fallback OCR parsing for table...");
            try {
                const rawText = await this.getTextInRegion(tableRegion, '6');
                const fallbackName = `prints/table_fallback_${context.nf || 'unknown'}.txt`;
                fs.writeFileSync(fallbackName, rawText);

                const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
                lines.forEach(line => {
                    if (line.length < 5 || !/\d/.test(line)) return;

                    const tokens = line.split(/\s+/);
                    if (tokens.length < 3) return;

                    let qtyIndex = -1;
                    for (let idx = tokens.length - 1; idx >= 1; idx--) {
                        const t = tokens[idx].replace(/\s/g, '');
                        if (/^\d+$/.test(t)) {
                            qtyIndex = idx;
                            break;
                        }
                    }
                    if (qtyIndex === -1) return;

                    const quantity = tokens[qtyIndex];
                    const code = tokens[0];

                    const locStart = Math.max(1, qtyIndex - 3);
                    const locationTokens = tokens.slice(locStart, qtyIndex);
                    const descriptionTokens = tokens.slice(1, locStart);

                    const product = {
                        raw: line,
                        codigo_barras: code,
                        descricao: descriptionTokens.join(' ').trim(),
                        localizacao: locationTokens.join(' ').trim(),
                        quantidade: quantity.trim()
                    };

                    if (!products.some(p => p.raw === product.raw)) {
                        products.push(product);
                    }
                });
            } catch (e) {
                this.log(`Fallback table parsing failed: ${e.message}`);
            }
        }
        
        this.log(`Extracted ${products.length} products.`);
        return products;
    }

    async extrairItensEtiqueta(context = {}, regionOverride = null) {
        const region = regionOverride && typeof regionOverride.x === 'number'
            ? {
                x: regionOverride.x,
                y: regionOverride.y,
                width: regionOverride.width || 1470,
                height: regionOverride.height || 676
            }
            : (context.lastPrintRegion && typeof context.lastPrintRegion.x === 'number'
                ? {
                    x: context.lastPrintRegion.x,
                    y: context.lastPrintRegion.y,
                    width: context.lastPrintRegion.width || 1470,
                    height: context.lastPrintRegion.height || 676
                }
                : { x: 240, y: 170, width: 1470, height: 676 });
        this.log(`Extrair itens da tela Emissão de Etiqueta para NF ${context.nf || ''}...`);
        const psm = '6';
        const rawText = await this.getTextInRegion(region, psm);
        const debugName = `prints/etiqueta_items_ocr_${context.nf || 'unknown'}.txt`;
        try {
            fs.writeFileSync(debugName, rawText);
        } catch (e) {}

        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
        const items = [];

        for (const line of lines) {
            const lower = line.toLowerCase();
            if (!line) continue;
            if (lower.includes('cod') && lower.includes('produto')) continue;

            let codFabricante = '';
            let produto = '';
            let localizacao = '';
            let quantidade = '';

            let cols = line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);

            if (cols.length >= 4) {
                codFabricante = cols[0];
                produto = cols[1];
                localizacao = cols[2];
                quantidade = cols[3];
            } else {
                const tokens = line.split(/\s+/).filter(Boolean);
                if (tokens.length < 4) continue;

                let qtyIndex = -1;
                for (let idx = tokens.length - 1; idx >= 1; idx--) {
                    const t = tokens[idx].replace(/\s/g, '');
                    if (/^\d+$/.test(t)) {
                        qtyIndex = idx;
                        break;
                    }
                }
                if (qtyIndex === -1) continue;

                quantidade = tokens[qtyIndex];
                codFabricante = tokens[0];

                const locStart = Math.max(1, qtyIndex - 3);
                const locationTokens = tokens.slice(locStart, qtyIndex);
                const descTokens = tokens.slice(1, locStart);

                produto = descTokens.join(' ');
                localizacao = locationTokens.join(' ');
            }

            if (!codFabricante || !produto || !localizacao || !quantidade) continue;

            items.push({
                codFabricante: codFabricante.trim(),
                produto: produto.trim(),
                localizacao: localizacao.trim(),
                quantidade: quantidade.trim()
            });
        }

        this.log(`Extrair itens etiqueta retornou ${items.length} itens.`);
        const enhanced = await this.aiEnhanceTableItems(items, context);
        return enhanced;
    }

    async aiEnhanceTableItems(items, context = {}) {
        try {
            const useOpenAI = !!process.env.OPENAI_API_KEY;
            if (!useOpenAI || typeof fetch !== 'function') {
                return this.ruleBasedClean(items);
            }
            const sys = 'Você é um assistente que corrige itens de uma tabela de produtos extraídos por OCR. Retorne somente JSON válido com o array ajustado.';
            const user = JSON.stringify({
                nf: context.nf || null,
                items,
                rules: {
                    requiredColumns: ['codFabricante','produto','localizacao','quantidade'],
                    quantidadeNumeric: true,
                    trimAll: true,
                    dropIncomplete: true
                }
            });
            const body = {
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: user }
                ],
                temperature: 0.2,
                response_format: { type: 'json_object' }
            };
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                return this.ruleBasedClean(items);
            }
            const data = await res.json();
            const txt = data?.choices?.[0]?.message?.content || '';
            let parsed = null;
            try {
                parsed = JSON.parse(txt);
            } catch {}
            const out = Array.isArray(parsed?.items) ? parsed.items : null;
            if (!out) return this.ruleBasedClean(items);
            return out.map(it => ({
                codFabricante: String(it.codFabricante || '').trim(),
                produto: String(it.produto || '').trim(),
                localizacao: String(it.localizacao || '').trim(),
                quantidade: String((it.quantidade ?? '')).toString().replace(/[^\d]/g, '').trim()
            })).filter(it => it.codFabricante && it.produto && it.localizacao && it.quantidade);
        } catch {
            return this.ruleBasedClean(items);
        }
    }

    ruleBasedClean(items) {
        const cleaned = [];
        for (const it of items) {
            const cod = String(it.codFabricante || '').trim();
            const prod = String(it.produto || '').trim();
            const loc = String(it.localizacao || '').trim();
            const qtd = String(it.quantidade ?? '').toString().replace(/[^\d]/g, '').trim();
            if (cod && prod && loc && qtd) {
                cleaned.push({ codFabricante: cod, produto: prod, localizacao: loc, quantidade: qtd });
            }
        }
        return cleaned;
    }
    ensurePrintsDir() {
        try {
            if (!fs.existsSync('prints')) {
                fs.mkdirSync('prints', { recursive: true });
            }
        } catch (e) {}
    }
    async detectarColunasPorCabecalho(baseRegion) {
        const band = { x: baseRegion.x, y: baseRegion.y, width: baseRegion.width, height: Math.min(80, baseRegion.height) };
        const words = await this.getWordsInRegion(band, '6');
        const tokens = words.map(w => ({ x: (w.bbox.x0 + w.bbox.x1) / 2, t: (w.text || '').toLowerCase() }));
        const near = (a, b) => Math.abs(a - b) < 150;
        const has = (s, arr) => arr.some(rx => rx.test(s));
        let cods = tokens.filter(v => has(v.t, [/^cod\b/, /^cód\b/, /^cod\./, /fabricante/]));
        let produtos = tokens.filter(v => has(v.t, [/produto/]));
        let locais = tokens.filter(v => has(v.t, [/localiza/]));
        let qtds = tokens.filter(v => has(v.t, [/^qtd\b/, /^qtde\b/, /^quant/i]));
        let codX = null;
        for (const c of cods) {
            if (/fabricante/.test(c.t)) continue;
            const parceiro = cods.find(o => /fabricante/.test(o.t) && near(o.x, c.x + 100));
            if (parceiro) {
                codX = Math.min(c.x, parceiro.x);
                break;
            }
        }
        if (codX === null && cods.length) codX = Math.min(...cods.map(v => v.x));
        const prodX = produtos.length ? Math.min(...produtos.map(v => v.x)) : null;
        const locX = locais.length ? Math.min(...locais.map(v => v.x)) : null;
        const qtdX = qtds.length ? Math.min(...qtds.map(v => v.x)) : null;
        const cols = [];
        if (codX !== null) cols.push({ key: 'cod', x: codX });
        if (prodX !== null) cols.push({ key: 'produto', x: prodX });
        if (locX !== null) cols.push({ key: 'localizacao', x: locX });
        if (qtdX !== null) cols.push({ key: 'qtd', x: qtdX });
        if (cols.length < 2) return null;
        cols.sort((a, b) => a.x - b.x);
        const mids = [];
        for (let i = 0; i < cols.length - 1; i++) {
            mids.push(Math.round((cols[i].x + cols[i + 1].x) / 2));
        }
        const start = baseRegion.x;
        const end = baseRegion.x + baseRegion.width;
        const ranges = {};
        for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            const left = i === 0 ? start : mids[i - 1];
            const right = i === cols.length - 1 ? end : mids[i];
            ranges[c.key] = { x: left - baseRegion.x, width: Math.max(10, right - left) };
        }
        if (!ranges.cod || !ranges.produto || !ranges.localizacao || !ranges.qtd) return ranges;
        return ranges;
    }
    async extrairItensTabela(context = {}, regionOverride = null) {
        const baseRegion = regionOverride && typeof regionOverride.x === 'number'
            ? {
                x: regionOverride.x,
                y: regionOverride.y,
                width: regionOverride.width || 1470,
                height: regionOverride.height || 676
            }
            : (context.lastPrintRegion && typeof context.lastPrintRegion.x === 'number'
                ? {
                    x: context.lastPrintRegion.x,
                    y: context.lastPrintRegion.y,
                    width: context.lastPrintRegion.width || 1470,
                    height: context.lastPrintRegion.height || 676
                }
                : { x: 240, y: 170, width: 1470, height: 676 });

        let colunas = await this.detectarColunasPorCabecalho(baseRegion);
        if (!colunas) {
            colunas = {
                cod: { x: 0, width: Math.round(baseRegion.width * 0.15) },
                produto: { x: Math.round(baseRegion.width * 0.15), width: Math.round(baseRegion.width * 0.5) },
                localizacao: { x: Math.round(baseRegion.width * 0.66), width: Math.round(baseRegion.width * 0.14) },
                qtd: { x: Math.round(baseRegion.width * 0.8), width: Math.round(baseRegion.width * 0.08) }
            };
        }

        const HEADER_HEIGHT = 24;
        const rowTolerance = 12;

        const words = await this.getWordsInRegion(baseRegion, '6');
        const rows = {};

        for (const w of words) {
            const centerY = (w.bbox.y0 + w.bbox.y1) / 2;
            if (centerY < baseRegion.y + HEADER_HEIGHT || centerY > baseRegion.y + baseRegion.height) {
                continue;
            }
            const key = Math.round(centerY / rowTolerance) * rowTolerance;
            if (!rows[key]) rows[key] = [];
            rows[key].push(w);
        }

        const sortedKeys = Object.keys(rows).map(k => parseInt(k, 10)).sort((a, b) => a - b);
        const itens = [];

        for (const key of sortedKeys) {
            const rowWords = rows[key].sort((a, b) => a.bbox.x0 - b.bbox.x0);
            if (rowWords.length === 0) continue;

            const fullText = rowWords.map(w => w.text).join(' ').toLowerCase();
            if (fullText.includes('cod') && fullText.includes('produto')) continue;

            const codParts = [];
            const prodParts = [];
            const locParts = [];
            const qtdParts = [];

            for (const w of rowWords) {
                const centerX = (w.bbox.x0 + w.bbox.x1) / 2;
                const localX = centerX - baseRegion.x;

                if (localX < 0 || localX >= baseRegion.width) continue;

                if (localX >= colunas.cod.x && localX < colunas.cod.x + colunas.cod.width) {
                    codParts.push(w.text);
                } else if (localX >= colunas.produto.x && localX < colunas.produto.x + colunas.produto.width) {
                    prodParts.push(w.text);
                } else if (localX >= colunas.localizacao.x && localX < colunas.localizacao.x + colunas.localizacao.width) {
                    locParts.push(w.text);
                } else if (localX >= colunas.qtd.x && localX < colunas.qtd.x + colunas.qtd.width) {
                    qtdParts.push(w.text);
                }
            }

            let codFabricante = codParts.join('').trim();
            let produto = prodParts.join(' ').trim();
            let localizacao = locParts.join(' ').trim();
            let quantidade = qtdParts.join('').replace(/[^\d]/g, '').trim();

            if (!codFabricante || !produto || !localizacao || !quantidade) {
                const tokens = rowWords.map(w => w.text).join(' ').split(/\s+/).filter(Boolean);
                if (tokens.length >= 4) {
                    let qtyIndex = -1;
                    for (let idx = tokens.length - 1; idx >= 1; idx--) {
                        const t = tokens[idx].replace(/[^\d]/g, '');
                        if (t) {
                            qtyIndex = idx;
                            break;
                        }
                    }
                    if (qtyIndex > 1) {
                        quantidade = tokens[qtyIndex].replace(/[^\d]/g, '').trim();
                        codFabricante = tokens[0].trim();
                        localizacao = tokens[qtyIndex - 1].trim();
                        produto = tokens.slice(1, qtyIndex - 1).join(' ').trim();
                    }
                }
            }

            if (!codFabricante && !produto && !localizacao && !quantidade) continue;

            if (!codFabricante || !produto || !localizacao || !quantidade) continue;

            itens.push({
                codFabricante,
                produto,
                localizacao,
                quantidade
            });
        }

        const enhanced = await this.aiEnhanceTableItems(itens, context);
        this.log(`extrairItensTabela retornou ${enhanced.length} itens.`);
        return enhanced;
    }

    async extrairItensTabelaSharp(context = {}, regionOverride = null) {
        const nf = context.nf || 'unknown';
        const baseName = `etiqueta_items_${nf}.png`;
        const imagePath = context.lastPrintFile && fs.existsSync(context.lastPrintFile)
            ? context.lastPrintFile
            : path.join('prints', baseName);
        if (!fs.existsSync(imagePath)) {
            return [];
        }
        const tmpName = path.join('prints', `tabela_crop_${nf}.png`);
        let text = '';
        try {
            const img = sharp(imagePath);
            const meta = await img.metadata();
            const cropWidth = Math.min((regionOverride && regionOverride.width) || 1600, meta.width || 1600);
            const cropHeight = Math.min((regionOverride && regionOverride.height) || 700, meta.height || 700);
            await img.extract({ left: 0, top: 0, width: cropWidth, height: cropHeight }).toFile(tmpName);
            const result = await Tesseract.recognize(tmpName, 'por', { logger: () => {} });
            text = result.data.text;
        } catch (e) {
            return [];
        }
        const linhas = text.split('\n');
        const itens = [];
        for (let linha of linhas) {
            if (!linha.trim()) continue;
            if (linha.includes('Cod') || linha.includes('Produto') || linha.includes('PRODUTO')) continue;
            const colunas = linha.split(/\s{2,}/);
            if (colunas.length >= 4) {
                const qtdNum = parseInt(colunas[3].trim().replace(/[^\d]/g, ''), 10);
                if (!colunas[0].trim() || !colunas[1].trim() || !colunas[2].trim() || Number.isNaN(qtdNum)) {
                    continue;
                }
                itens.push({
                    codFabricante: colunas[0].trim(),
                    produto: colunas[1].trim(),
                    localizacao: colunas[2].trim(),
                    quantidade: String(qtdNum)
                });
            }
        }
        const enhanced = await this.aiEnhanceTableItems(itens, context);
        return enhanced;
    }

    /**
     * NOVA FUNÇÃO MELHORADA: Detecta linhas de NF usando OCR em coluna (Mais robusto)
     */
    async detectInvoiceRows(scanRegion) {
        this.log("Detecting invoice rows using Smart Column Clustering (Full Page Scan)...");
        
        // 1. Scan the entire screen to ensure we capture the table context
        // Use PSM 3 (Auto) as it worked in previous logs
        const region = { x: 0, y: 0, width: 1920, height: 1000 };
        
        const words = await this.getWordsInRegion(region, '3');
        
        const potentialInvoices = [];
        const minY = 100; // Lowered from 200 to catch higher rows
        
        // 2. Filter for Number-like strings
        this.log(`Scanning ${words.length} words for numbers...`);
        for (const w of words) {
            const text = w.text.trim();
            // Regex: 5 to 10 digits
            if (/^\d{5,10}$/.test(text)) {
                const val = parseInt(text, 10);
                
                // Check Y position (must be below header)
                const centerY = (w.bbox.y0 + w.bbox.y1) / 2;
                
                this.log(`Candidate: ${text} at Y=${centerY.toFixed(0)} (Val: ${val})`);
                
                if (val >= 2000 && val <= 2050) {
                    this.log(`  -> Ignored as Year`);
                    continue;
                }
                
                if (centerY > minY) {
                    potentialInvoices.push(w);
                    this.log(`  -> ACCEPTED`);
                } else {
                    this.log(`  -> Ignored (Y < ${minY})`);
                }
            }
        }
        
        this.log(`Found ${potentialInvoices.length} potential invoice numbers below Y=${minY}.`);
        
        if (potentialInvoices.length === 0) {
             this.log("No numbers found. Capturing debug image...");
             await this.page.screenshot({ path: 'debug_no_numbers.png' });
             return [];
        }

        // 3. Cluster by X Coordinate
        const clusters = {};
        const toleranceX = 50; 
        
        for (const item of potentialInvoices) {
            let placed = false;
            for (const key in clusters) {
                const clusterX = parseInt(key, 10);
                if (Math.abs(item.bbox.x0 - clusterX) < toleranceX) {
                    clusters[key].push(item);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                clusters[item.bbox.x0] = [item];
            }
        }
        
        // 4. Find the Best Cluster
        let bestCluster = null;
        let maxItems = 0;
        
        for (const key in clusters) {
            const items = clusters[key];
            this.log(`Cluster at X=${key}: ${items.length} items. Examples: ${items.slice(0,3).map(i=>i.text).join(', ')}`);
            
            if (items.length > maxItems) {
                maxItems = items.length;
                bestCluster = items;
            }
        }
        
        if (!bestCluster) return [];
        
        this.log(`Selected Best Cluster with ${bestCluster.length} items.`);
        
        // 5. Convert to Rows
        const rows = bestCluster.map(item => {
            const centerX = (item.bbox.x0 + item.bbox.x1) / 2;
            const centerY = (item.bbox.y0 + item.bbox.y1) / 2;
            
            return {
                nf: item.text,
                centerX: centerX, 
                centerY: centerY,
                absY: centerY
            };
        });
        
        rows.sort((a, b) => a.centerY - b.centerY);
        
        return rows;
    }

    /**
     * FUNÇÃO PRINCIPAL MELHORADA: Processa todas as NFs da lista com scroll
     */
    async processAllInvoices() {
        this.log("\n" + "=".repeat(60));
        this.log("STARTING INVOICE PROCESSING - TRACKING Y STRATEGY");
        this.log("Strategy: Focus List -> Arrow Down -> Enter -> Extract -> Repeat");
        this.log("=".repeat(60));

        const processedInvoices = new Set();
        const allResults = [];
        
        // 1. Ensure Focus on List and Reset to Top
        this.log("Resetting to top (Home key)...");
        // Removed click at 960,300 to avoid minimizing list (managed by coordinates.json or Home key)
        await this.delay(500);
        await this.page.keyboard.press('Home');
        await this.delay(2000); // Wait for scroll animation

        // Capture screenshot of the list to debug buttons/layout
        await this.page.screenshot({ path: 'debug_list_screen.png' });
        this.log("Saved debug_list_screen.png");

        // 2. Detect Rows to find valid Y coordinates
        let currentVisualY = 280; // Default fallback
        const detectedRows = await this.detectInvoiceRows();
        
        if (detectedRows.length > 0) {
            // Use the first detected row's Y
            currentVisualY = detectedRows[0].centerY;
            this.log(`✓ Detected first row at Y=${currentVisualY} (Text: ${detectedRows[0].nf})`);
        } else {
            this.log("⚠ No invoice rows detected via OCR. Using default Y=280.");
        }

        let lastAccessKey = null;
        let consecutiveFailures = 0;
        const maxFailures = 10;
        const maxInvoices = 1000;
        
        const ROW_HEIGHT = 28; // Approximate row height
        const LIST_BOTTOM = 850; // Approximate bottom of list view

        for (let i = 0; i < maxInvoices; i++) {
            this.log(`\n--- Invoice #${i + 1} ---`);

            // Open Details
            this.log(`Attempting to open details (Est Y: ${currentVisualY})...`);
            
            let detailsOpen = false;

            // Strategy 1: Enter Key (Standard - relies on ArrowDown selection)
            this.log("Strategy 1: Pressing Enter...");
            await this.page.keyboard.press('Enter');
            detailsOpen = await this.waitForDetailsScreen(2);

            // Strategy 2: NumpadEnter
            if (!detailsOpen) {
                this.log("Strategy 2: Pressing NumpadEnter...");
                await this.page.keyboard.press('NumpadEnter');
                detailsOpen = await this.waitForDetailsScreen(2);
            }

            // Strategy 3: Double Click at Estimated Y
            if (!detailsOpen) {
                this.log(`Strategy 3: Double Click at Estimated Y (${currentVisualY})...`);
                // Try Center
                await this.page.mouse.dblclick(960, currentVisualY);
                detailsOpen = await this.waitForDetailsScreen(2);
                
                if (!detailsOpen) {
                    // Try Left (Access Key / Number column)
                    await this.page.mouse.dblclick(400, currentVisualY);
                    detailsOpen = await this.waitForDetailsScreen(2);
                }
            }

            // Strategy 4: Context Menu -> Open (Right Click -> Arrow Down -> Enter)
            if (!detailsOpen) {
                this.log("Strategy 4: Context Menu (Right Click -> ArrowDown -> Enter)...");
                await this.page.mouse.click(960, currentVisualY, { button: 'right' });
                await this.delay(500);
                await this.page.keyboard.press('ArrowDown'); // Select first option
                await this.delay(200);
                await this.page.keyboard.press('Enter');
                detailsOpen = await this.waitForDetailsScreen(3);
            }

            // Fallback: Vertical Scan around Estimated Y if previous failed
            if (!detailsOpen) {
                this.log("Fallback: Vertical Scan Double Click...");
                const offsets = [-10, 0, 10, 20];
                for (const offset of offsets) {
                     const scanY = currentVisualY + offset;
                     this.log(`  Scanning Y=${scanY}...`);
                     await this.page.mouse.dblclick(960, scanY);
                     if (await this.waitForDetailsScreen(1)) {
                         detailsOpen = true;
                         break;
                     }
                }
            }
            
            // Final Fallback: Step 5 Location (known to work sometimes)
            if (!detailsOpen) {
                 this.log("Final Fallback: Clicking Step 5 Location (655, 368)...");
                 await this.page.mouse.click(655, 368);
                 await this.delay(200);
                 await this.page.keyboard.press('Enter');
                 detailsOpen = await this.waitForDetailsScreen(2);
            }

            if (detailsOpen) {
                this.log("✓ Details screen OPENED!");
                consecutiveFailures = 0;

                // Extract (Skip Opening logic since it's already open)
                const result = await this.extractInvoiceDetails(null, null, null, true);
                
                if (result && !result.error) {
                    const currentAccessKey = result.chave_acesso;
                    const cleanNF = result.nota_fiscal;

                    // CHECK DUPLICATE (Stop Condition)
                    if (currentAccessKey && currentAccessKey === lastAccessKey) {
                        this.log(`🛑 Stopping: Duplicate Access Key detected (${currentAccessKey}). End of list reached.`);
                        await this.closeDetailsScreen();
                        break;
                    }

                    if (processedInvoices.has(cleanNF)) {
                         this.log(`⚠ Warning: Invoice ${cleanNF} already processed. Continuing...`);
                    }

                    processedInvoices.add(cleanNF);
                    allResults.push(result);
                    lastAccessKey = currentAccessKey;
                    
                    this.log(`✓ Processed: ${cleanNF}`);
                } else {
                    this.log("⚠ Extraction failed.");
                }

                // Close Details
                await this.closeDetailsScreen();
                await this.delay(1000);
            } else {
                this.log("⚠ Failed to open details screen.");
                consecutiveFailures++;
                if (consecutiveFailures >= 10) {
                    this.log("🛑 Stopping: Too many consecutive failures (10).");
                    break;
                }
                
                await this.page.screenshot({ path: `debug_fail_open_${i}.png` });
            }

            // Move to Next
            this.log("Moving to next invoice (Arrow Down)...");
            await this.page.keyboard.press('ArrowDown');
            await this.delay(500);

            // Update Visual Y
            currentVisualY += ROW_HEIGHT;
            if (currentVisualY > LIST_BOTTOM) {
                currentVisualY = LIST_BOTTOM; 
            }
        }
        
        // Final Report
        this.log("\n" + "=".repeat(60));
        this.log("PROCESSING COMPLETE");
        this.log("=".repeat(60));
        this.log(`Total Invoices Processed: ${processedInvoices.size}`);
        
        const report = {
            timestamp: new Date().toISOString(),
            total_invoices: processedInvoices.size,
            invoices: allResults
        };

        fs.writeFileSync('processing_report.json', JSON.stringify(report, null, 2));
        this.log("\n✓ Report saved to 'processing_report.json'");

        return report;
    }

    async waitForScreenMatch(imagePath) {
        this.log(`Waiting for screen to match reference: ${imagePath}`);
        // [Manter implementação existente]
        return true; // Simplificado para exemplo
    }

    async setupOverlay() {
        await this.page.evaluate(() => {
            // Main Panel
            const overlay = document.createElement('div');
            overlay.id = 'bot-overlay';
            overlay.style.position = 'fixed';
            overlay.style.bottom = '20px';
            overlay.style.right = '10px';
            overlay.style.width = '350px';
            overlay.style.maxHeight = '80vh';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
            overlay.style.color = 'white';
            overlay.style.padding = '15px';
            overlay.style.borderRadius = '10px';
            overlay.style.zIndex = '9999999';
            overlay.style.fontFamily = 'Segoe UI, Arial, sans-serif';
            overlay.style.fontSize = '12px';
            overlay.style.overflowY = 'auto';
            overlay.style.boxShadow = '0 4px 20px rgba(0,0,0,0.7)';
            overlay.style.border = '1px solid #444';
            document.body.appendChild(overlay);

            // Toast Notification (Large Center Text)
            const toast = document.createElement('div');
            toast.id = 'bot-toast';
            toast.style.position = 'fixed';
            toast.style.bottom = '100px';
            toast.style.left = '50%';
            toast.style.transform = 'translateX(-50%)';
            toast.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
            toast.style.color = '#00ff00';
            toast.style.padding = '15px 30px';
            toast.style.borderRadius = '50px';
            toast.style.fontSize = '24px';
            toast.style.fontWeight = 'bold';
            toast.style.zIndex = '9999999';
            toast.style.pointerEvents = 'none';
            toast.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
            toast.style.border = '2px solid #00ff00';
            toast.style.opacity = '0'; // Hidden by default
            toast.style.transition = 'opacity 0.3s ease';
            document.body.appendChild(toast);
        });
    }

    async showRegionHighlight(x, y, width, height, color = 'red') {
        try {
            await this.page.evaluate(({x, y, width, height, color}) => {
                let box = document.getElementById('bot-highlight-box');
                if (!box) {
                    box = document.createElement('div');
                    box.id = 'bot-highlight-box';
                    box.style.position = 'fixed';
                    box.style.zIndex = '9999998';
                    box.style.pointerEvents = 'none';
                    box.style.transition = 'all 0.2s ease';
                    box.style.boxSizing = 'border-box'; // Ensure border is included in width/height
                    document.body.appendChild(box);
                }
                box.style.left = x + 'px';
                box.style.top = y + 'px';
                box.style.width = width + 'px';
                box.style.height = height + 'px';
                box.style.border = `2px solid ${color}`;
                box.style.backgroundColor = 'transparent'; // Clean view for OCR/Screenshot
                box.style.display = 'block';
            }, {x, y, width, height, color});
        } catch (e) {
            // Ignore errors during navigation
        }
    }

    async clearHighlight() {
        try {
            await this.page.evaluate(() => {
                const box = document.getElementById('bot-highlight-box');
                if (box) box.style.display = 'none';
            });
            await this.clearDragHighlight();
        } catch (e) {}
    }

    async showDragHighlight(startX, startY, endX, endY) {
        try {
            await this.page.evaluate(({startX, startY, endX, endY}) => {
                let container = document.getElementById('bot-drag-container');
                if (!container) {
                    container = document.createElement('div');
                    container.id = 'bot-drag-container';
                    container.style.position = 'fixed';
                    container.style.top = '0';
                    container.style.left = '0';
                    container.style.width = '100%';
                    container.style.height = '100%';
                    container.style.pointerEvents = 'none';
                    container.style.zIndex = '9999998';
                    document.body.appendChild(container);
                }
                container.innerHTML = ''; // Clear previous

                // Draw Start Point
                const startBox = document.createElement('div');
                startBox.style.position = 'absolute';
                startBox.style.left = (startX - 10) + 'px';
                startBox.style.top = (startY - 10) + 'px';
                startBox.style.width = '20px';
                startBox.style.height = '20px';
                startBox.style.borderRadius = '50%';
                startBox.style.backgroundColor = 'rgba(0, 255, 0, 0.5)';
                startBox.style.border = '2px solid green';
                startBox.style.boxShadow = '0 0 10px green';
                container.appendChild(startBox);

                // Draw End Point
                const endBox = document.createElement('div');
                endBox.style.position = 'absolute';
                endBox.style.left = (endX - 10) + 'px';
                endBox.style.top = (endY - 10) + 'px';
                endBox.style.width = '20px';
                endBox.style.height = '20px';
                endBox.style.borderRadius = '50%';
                endBox.style.backgroundColor = 'rgba(255, 0, 0, 0.5)';
                endBox.style.border = '2px solid red';
                endBox.style.boxShadow = '0 0 10px red';
                container.appendChild(endBox);

                // Draw Line (SVG)
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.style.width = '100%';
                svg.style.height = '100%';
                svg.style.position = 'absolute';
                svg.style.left = '0';
                svg.style.top = '0';
                
                const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                line.setAttribute("x1", startX);
                line.setAttribute("y1", startY);
                line.setAttribute("x2", endX);
                line.setAttribute("y2", endY);
                line.setAttribute("stroke", "yellow");
                line.setAttribute("stroke-width", "3");
                line.setAttribute("stroke-dasharray", "5,5");
                
                // Add Arrowhead marker
                const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
                const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
                marker.setAttribute("id", "arrow");
                marker.setAttribute("viewBox", "0 0 10 10");
                marker.setAttribute("refX", "5");
                marker.setAttribute("refY", "5");
                marker.setAttribute("markerWidth", "6");
                marker.setAttribute("markerHeight", "6");
                marker.setAttribute("orient", "auto-start-reverse");
                
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
                path.setAttribute("fill", "yellow");
                
                marker.appendChild(path);
                defs.appendChild(marker);
                svg.appendChild(defs);
                
                line.setAttribute("marker-end", "url(#arrow)");
                
                svg.appendChild(line);
                container.appendChild(svg);
                
            }, {startX, startY, endX, endY});
        } catch (e) {}
    }

    async clearDragHighlight() {
        try {
            await this.page.evaluate(() => {
                const container = document.getElementById('bot-drag-container');
                if (container) container.remove();
            });
        } catch (e) {}
    }

    async updateOverlay(currentIndex, steps, context = {}) {
        try {
            // Always clear drag highlight when moving to a new step
            await this.clearDragHighlight();

            // Highlight region if applicable for current step
            const currentStep = steps[currentIndex];
            if (currentStep && currentStep.width && currentStep.height) {
                await this.showRegionHighlight(currentStep.x, currentStep.y, currentStep.width, currentStep.height);
            } else {
                await this.clearHighlight();
            }

            // Interpolate description for display
            const formatDesc = (desc) => {
                if (desc && desc.includes('{{nf}}')) {
                    return desc.replace('{{nf}}', context.nf || '???');
                }
                return desc;
            };

            const currentWidth = currentStep && typeof currentStep.width === 'number' ? currentStep.width : 0;
            const currentHeight = currentStep && typeof currentStep.height === 'number' ? currentStep.height : 0;

            await this.page.evaluate(({ currentIndex, steps, formattedCurrentDesc, currentX, currentY, currentWidth, currentHeight, isPaused, isLast, isRecording }) => {
                const overlay = document.getElementById('bot-overlay');
                if (overlay) {
                    overlay.style.pointerEvents = 'auto';
                    // Helper to toggle pause state in UI immediately
                    window.togglePauseUI = (paused) => {
                         const btnPause = document.getElementById('btn-pause');
                         const btnResume = document.getElementById('btn-resume');
                         if (paused) {
                             btnPause.style.display = 'none';
                             btnResume.style.display = 'block';
                             document.body.classList.add('bot-paused');
                         } else {
                             btnPause.style.display = 'block';
                             btnResume.style.display = 'none';
                             document.body.classList.remove('bot-paused');
                         }
                    };

                    // --- HEADER & CONTROLS ---
                    let html = `
                        <div style="border-bottom:1px solid #555; padding-bottom:10px; margin-bottom:10px;">
                            <h3 style="margin:0 0 10px 0; font-size:16px; color:#fff; text-align:center;">🤖 Bot Action Panel</h3>
                            
                            <!-- MAIN CONTROLS -->
                            <div style="display:flex; justify-content:center; gap:5px; margin-bottom:10px;">
                                <button id="btn-pause" onclick="window.control_pause(); window.togglePauseUI(true);" style="background:#ffc107; color:#000; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; display:${isPaused ? 'none' : 'block'}; width:80px; font-weight:bold;">⏸ Pause</button>
                                <button id="btn-resume" onclick="window.control_resume(); window.togglePauseUI(false);" style="background:#28a745; color:#fff; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; display:${isPaused ? 'block' : 'none'}; width:80px; font-weight:bold;">▶ Resume</button>
                                <button onclick="window.control_jump_step(${currentIndex})" style="background:#17a2b8; color:#fff; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">↻ Replay Step</button>
                            </div>

                            <!-- COORDS EDITOR -->
                            <div style="background:rgba(255,255,255,0.1); padding:8px; border-radius:4px;">
                                <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                                    <label style="width:20px;">X:</label>
                                    <input id="inp-x" type="number" value="${currentX || 0}" style="width:80px; padding:4px; background:#333; color:#fff; border:1px solid #555; border-radius:4px;">
                                    <label style="width:20px;">Y:</label>
                                    <input id="inp-y" type="number" value="${currentY || 0}" style="width:80px; padding:4px; background:#333; color:#fff; border:1px solid #555; border-radius:4px;">
                                </div>
                                <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                                    <label style="width:20px;">W:</label>
                                    <input id="inp-w" type="number" value="${currentWidth || 0}" style="width:80px; padding:4px; background:#333; color:#fff; border:1px solid #555; border-radius:4px;">
                                    <label style="width:20px;">H:</label>
                                    <input id="inp-h" type="number" value="${currentHeight || 0}" style="width:80px; padding:4px; background:#333; color:#fff; border:1px solid #555; border-radius:4px;">
                                    <button id="btn-inline-save" title="Salvar coordenadas deste passo" style="background:#dc3545; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-weight:bold;">Salvar</button>
                                </div>
                                <div style="display:flex; gap:5px;">
                                    <button onclick="window.control_test_click(document.getElementById('inp-x').value, document.getElementById('inp-y').value)" style="flex:1; background:#6c757d; color:#fff; border:none; padding:4px; border-radius:4px; cursor:pointer; font-size:11px;">Target 🎯</button>
                                    <button onclick="window.control_update_step(${currentIndex}, document.getElementById('inp-x').value, document.getElementById('inp-y').value, document.getElementById('inp-w').value, document.getElementById('inp-h').value)" style="flex:1; background:#007bff; color:#fff; border:none; padding:4px; border-radius:4px; cursor:pointer; font-size:11px;">Update</button>
                                    <button onclick="window.control_save_coords()" style="flex:1; background:#dc3545; color:#fff; border:none; padding:4px; border-radius:4px; cursor:pointer; font-size:11px;">Save JSON 💾</button>
                                </div>
                                ${isLast ? `<div style="margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
                                    <button id="btn-record-action" style="background:${isRecording ? '#dc3545' : '#17a2b8'}; color:#fff; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;">
                                        ${isRecording ? 'Parar & Salvar ⏺' : 'Gravar Ação ✅'}
                                    </button>
                                    <span id="recording-status" style="font-size:11px; color:${isRecording ? '#28a745' : '#ccc'};">
                                        ${isRecording ? 'Gravando movimentações...' : 'Gravação parada'}
                                    </span>
                                </div>` : ''}
                            </div>
                        </div>
                    `;
                    
                    // --- STEPS LIST ---
                    html += '<div style="display:flex; flex-direction:column; gap:4px;">';
                    
                    for (let i = 0; i < steps.length; i++) {
                        const isCurrent = i === currentIndex;
                        const isPast = i < currentIndex;
                        
                        let style = 'padding:6px; border-radius:4px; font-size:13px; cursor:pointer;';
                        let icon = '○';
                        let onClick = `onclick="window.control_pause(); window.togglePauseUI(true); window.control_jump_step(${i})"`;
                        
                        if (isPast) {
                            style += 'color:#888; border-left:3px solid #555; background:rgba(255,255,255,0.05);';
                            icon = '✓';
                        } else if (isCurrent) {
                            style += 'color:#fff; font-weight:bold; background:rgba(40, 167, 69, 0.3); border-left: 3px solid #28a745; box-shadow: 0 2px 5px rgba(0,0,0,0.3);';
                            icon = '➤';
                            // Also allow clicking current step to replay it
                        } else {
                            style += 'color:#aaa; border-left:3px solid transparent;';
                            // Hover effect handled by CSS? Inline simplified.
                        }

                        let desc = steps[i].description;
                        if (isCurrent) desc = formattedCurrentDesc;

                        html += `<div id="step-${i}" style="${style}" ${onClick} title="Click to Execute/Replay">
                            <span style="display:inline-block; width:20px; text-align:center;">${icon}</span>
                            ${desc}
                        </div>`;
                    }
                    html += '</div>';

                    // Scroll to current
                    overlay.innerHTML = html;
                    
                    // Attach input handlers to keep typing smooth and stop event propagation
                    setTimeout(() => {
                        const xEl = document.getElementById('inp-x');
                        const yEl = document.getElementById('inp-y');
                        const wEl = document.getElementById('inp-w');
                        const hEl = document.getElementById('inp-h');
                        const btnInline = document.getElementById('btn-inline-save');
                        const btnRecord = document.getElementById('btn-record-action');
                        const stop = (e) => e.stopPropagation();
                        [xEl, yEl, wEl, hEl].forEach(el => {
                            if (!el) return;
                            ['keydown','keyup','keypress','wheel'].forEach(ev => el.addEventListener(ev, stop));
                            el.addEventListener('keydown', (e) => {
                                if (e.key === 'Enter') {
                                    window.control_update_and_save(
                                        currentIndex,
                                        xEl.value,
                                        yEl.value,
                                        wEl ? wEl.value : undefined,
                                        hEl ? hEl.value : undefined
                                    );
                                }
                            });
                        });
                        if (btnInline && xEl && yEl) {
                            btnInline.addEventListener('click', () => {
                                window.control_update_and_save(
                                    currentIndex,
                                    xEl.value,
                                    yEl.value,
                                    wEl ? wEl.value : undefined,
                                    hEl ? hEl.value : undefined
                                );
                            });
                        }
                        if (btnRecord) {
                            btnRecord.addEventListener('click', () => {
                                window.botRecording = !window.botRecording;
                                if (window.control_record_action) {
                                    window.control_record_action(window.botRecording);
                                }
                                // Recording UI handled from Node; just update button face here
                                const statusEl = document.getElementById('recording-status');
                                if (window.botRecording) {
                                    btnRecord.textContent = 'Parar & Salvar ⏺';
                                    btnRecord.style.background = '#dc3545';
                                    if (statusEl) {
                                        statusEl.textContent = 'Gravando movimentações...';
                                        statusEl.style.color = '#28a745';
                                    }
                                } else {
                                    btnRecord.textContent = 'Gravar Ação ✅';
                                    btnRecord.style.background = '#17a2b8';
                                    if (statusEl) {
                                        statusEl.textContent = 'Gravação parada';
                                        statusEl.style.color = '#ccc';
                                    }
                                }
                            });
                        }

                        if (!window.botRecordingInitialized) {
                            window.botRecordingInitialized = true;
                            window.botRecording = false;
                            window.botRecordedActions = [];
                            window.addEventListener('click', (e) => {
                                const overlayEl = document.getElementById('bot-overlay');
                                if (!window.botRecording) return;
                                if (overlayEl && overlayEl.contains(e.target)) return;
                                if (e.detail && e.detail > 1) return;
                                const evt = {
                                    type: 'click',
                                    x: e.clientX,
                                    y: e.clientY,
                                    timestamp: Date.now()
                                };
                                window.botRecordedActions.push(evt);
                                if (window.control_push_recorded_action) {
                                    window.control_push_recorded_action(evt);
                                }
                            }, true);

                            window.addEventListener('dblclick', (e) => {
                                const overlayEl = document.getElementById('bot-overlay');
                                if (!window.botRecording) return;
                                if (overlayEl && overlayEl.contains(e.target)) return;
                                const evt = {
                                    type: 'double_click',
                                    x: e.clientX,
                                    y: e.clientY,
                                    timestamp: Date.now()
                                };
                                if (window.control_push_recorded_action) {
                                    window.control_push_recorded_action(evt);
                                }
                            }, true);

                            window.addEventListener('keydown', (e) => {
                                const overlayEl = document.getElementById('bot-overlay');
                                if (!window.botRecording) return;
                                if (overlayEl && overlayEl.contains(e.target)) return;
                                const evt = {
                                    type: 'keypress',
                                    key: e.key,
                                    ctrlKey: e.ctrlKey,
                                    altKey: e.altKey,
                                    shiftKey: e.shiftKey,
                                    timestamp: Date.now()
                                };
                                if (window.control_push_recorded_action) {
                                    window.control_push_recorded_action(evt);
                                }
                            }, true);
                        }
                    }, 0);

                    // Only scroll if we haven't manually scrolled (simplification: always scroll for now)
                    setTimeout(() => {
                        const currentEl = document.getElementById(`step-${currentIndex}`);
                        if (currentEl) currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                }

                // Update Toast
                const toast = document.getElementById('bot-toast');
                if (toast) {
                    toast.innerText = formattedCurrentDesc;
                    toast.style.opacity = '1';
                }

            }, { 
                currentIndex, 
                steps, 
                formattedCurrentDesc: formatDesc(currentStep.description),
                currentX: currentStep.x,
                currentY: currentStep.y,
                isPaused: this.isPaused,
                isLast: currentIndex === (steps.length - 1),
                isRecording: this.isRecording
            });
        } catch (e) {
            // Ignore overlay errors (page might be navigating)
        }
    }

    async executeStep(step, context = {}) {
        // --- PAUSE & CONTROL LOGIC ---
        while (this.isPaused) {
            await this.delay(200);
            
            // Check if user requested a jump while paused
            if (this.jumpToStep !== null) {
                return { action: 'jump', index: this.jumpToStep };
            }
        }
        
        // Also check jump if not paused (hot jump)
        if (this.jumpToStep !== null) {
             return { action: 'jump', index: this.jumpToStep };
        }
        // -----------------------------

        this.log(`Executing: ${step.description} [Action: ${step.action || 'click'}]`);
        
        if (step.wait_before) {
            await this.delay(step.wait_before);
            // Re-check jump after delay
            if (this.jumpToStep !== null) return { action: 'jump', index: this.jumpToStep };
        }

        try {
            switch (step.action) {
                case 'scroll':
                    this.log(`Scrolling at (${step.x}, ${step.y}) by ${step.deltaY}...`);
                    await this.page.mouse.move(step.x, step.y);
                    await this.page.mouse.wheel(0, step.deltaY);
                    break;
                    
                case 'drag':
                    await this.showDragHighlight(step.startX, step.startY, step.endX, step.endY);
                    this.log(`Dragging mouse from (${step.startX}, ${step.startY}) to (${step.endX}, ${step.endY})...`);
                    await this.page.mouse.move(step.startX, step.startY);
                    await this.page.mouse.down();
                    await this.delay(300);
                    await this.page.mouse.move(step.endX, step.endY, { steps: 20 });
                    await this.delay(300);
                    await this.page.mouse.up();
                    break;

                case 'double_click':
                    this.log(`Double Clicking at (${step.x}, ${step.y})...`);
                    await this.visualClick(step.x, step.y, { doubleClick: true });
                    break;
                    
                case 'click_and_clear':
                    this.log(`Click and clear at (${step.x}, ${step.y})...`);
                    await this.visualClick(step.x, step.y, { doubleClick: true });
                    await this.delay(200);
                    await this.page.keyboard.press('Control+A');
                    await this.page.keyboard.press('Delete');
                    await this.delay(50);
                    await this.page.keyboard.press('Delete');
                    break;

                case 'type':
                    let textToType = step.text;
                    if (textToType && textToType.includes('{{nf}}') && (!context.nf || String(context.nf).trim() === '')) {
                        try {
                            const entered = await this.page.evaluate(() => {
                                return window.prompt('Digite o número da NF:');
                            });
                            if (entered) {
                                context.nf = String(entered).trim();
                            }
                        } catch (e) {}
                    }
                    if (textToType && textToType.includes('{{nf}}')) {
                        textToType = textToType.replace('{{nf}}', context.nf || '');
                    }
                    this.log(`Typing: "${textToType}"`);
                    if (textToType) {
                        if (step.x && step.y) {
                            await this.visualClick(step.x, step.y, { doubleClick: true });
                            await this.delay(200);
                        }
                        await this.page.keyboard.press('Control+A');
                        await this.page.keyboard.press('Delete');
                        await this.delay(50);
                        await this.page.keyboard.press('Delete');
                        await this.page.keyboard.type(textToType, { delay: 100 });
                    }
                    break;
                    
                case 'print':
                case 'screenshot':
                    const filename = `${step.print_purpose || 'debug'}_${Date.now()}.png`;
                    const hasRegion = typeof step.width === 'number' && typeof step.height === 'number' && step.width > 0 && step.height > 0;
                    if (hasRegion) {
                        const x = typeof step.x === 'number' ? step.x : 0;
                        const y = typeof step.y === 'number' ? step.y : 0;
                        this.log(`Taking regional screenshot: ${filename} at [${x}, ${y}, ${step.width}, ${step.height}]...`);
                        await this.page.screenshot({ 
                            path: filename,
                            clip: { x, y, width: step.width, height: step.height }
                        });
                    } else {
                        this.log(`Taking full-screen screenshot: ${filename}...`);
                        await this.page.screenshot({ path: filename });
                    }
                    break;
                    
                case 'find_text':
                    this.log(`Searching for text "${step.text}" on screen...`);
                    const fullScreenWords = await this.getWordsInRegion({ 
                        x: 0, y: 0, width: 1920, height: 1080 
                    }, '3');
                    const foundMatches = fullScreenWords.filter(w => 
                        w.text.toLowerCase().includes(step.text.toLowerCase())
                    );
                    if (foundMatches.length > 0) {
                        this.ensurePrintsDir();
                        this.log(`Found ${foundMatches.length} matches for "${step.text}"`);
                        fs.writeFileSync('prints/found_text.txt', JSON.stringify(foundMatches, null, 2));
                    } else {
                        this.log(`Text "${step.text}" not found.`);
                    }
                    break;

                case 'screenshot_region':
                    let baseName = step.filename || `region_${Date.now()}.png`;
                    if (baseName.includes('{{nf}}') && context.nf) {
                        baseName = baseName.replace('{{nf}}', String(context.nf));
                    }
                    const shotName = `prints/${baseName}`;
                    this.ensurePrintsDir();
                    this.log(`Capturing region [${step.x}, ${step.y}, ${step.width}, ${step.height}] to ${shotName}...`);
                    try {
                        await this.page.evaluate(() => {
                            const ids = ['bot-overlay', 'bot-highlight-box', 'bot-drag-container'];
                            window.__botPrevDisplay = {};
                            ids.forEach(id => {
                                const el = document.getElementById(id);
                                if (el) {
                                    window.__botPrevDisplay[id] = el.style.display;
                                    el.style.display = 'none';
                                }
                            });
                        });
                        await this.delay(50);
                        await this.page.screenshot({ 
                            path: shotName,
                            clip: { x: step.x, y: step.y, width: step.width, height: step.height }
                        });
                        context.lastPrintRegion = { x: step.x, y: step.y, width: step.width, height: step.height };
                        context.lastPrintFile = shotName;
                    } finally {
                        await this.page.evaluate(() => {
                            const ids = ['bot-overlay', 'bot-highlight-box', 'bot-drag-container'];
                            if (window.__botPrevDisplay) {
                                ids.forEach(id => {
                                    const el = document.getElementById(id);
                                    if (el) {
                                        el.style.display = window.__botPrevDisplay[id] ?? '';
                                    }
                                });
                            } else {
                                ids.forEach(id => {
                                    const el = document.getElementById(id);
                                    if (el) el.style.display = '';
                                });
                            }
                        });
                    }
                    break;

                case 'ocr_region':
                    await this.clearHighlight();
                    await this.delay(100);

                    const psmMode = step.psm || '6';
                    this.log(`Running OCR on region [${step.x}, ${step.y}, ${step.width}, ${step.height}]...`);
                    const regionWords = await this.getWordsInRegion({ 
                        x: step.x, y: step.y, width: step.width, height: step.height 
                    }, psmMode);
                    
                    let extractedText = regionWords.map(w => w.text).join('\n');
                    if (!extractedText.trim()) {
                        extractedText = await this.getTextInRegion({ 
                            x: step.x, y: step.y, width: step.width, height: step.height 
                        }, psmMode);
                    }

                    this.log(`OCR Result: ${extractedText.replace(/\n/g, ' ')}`);
                    
                    if (step.description.includes("Chave de Acesso")) {
                        const key = extractedText.replace(/\D/g, '');
                        if (key.length === 44) {
                            context.accessKey = key;
                            this.log(`✓ Access Key Captured: ${key}`);
                        }
                    }

                    if (step.find_keyword) {
                        if (extractedText.toLowerCase().includes(step.find_keyword.toLowerCase())) {
                            this.log(`✓ Keyword "${step.find_keyword}" found.`);
                        } else {
                            this.log(`⚠ Keyword "${step.find_keyword}" NOT found.`);
                            throw new Error(`Keyword "${step.find_keyword}" not found in OCR result`);
                        }
                    }
                    this.ensurePrintsDir();
                    fs.writeFileSync('prints/ocr_result.txt', extractedText);
                    fs.appendFileSync('prints/all_invoices_cumulative.txt', `--- Region at ${step.y} ---\n${extractedText}\n`);
                    break;

                case 'extract_access_key':
                    this.log("Capturando chave de acesso via Ctrl+C da tela da NF...");
                    try {
                        await clipboardy.write('');
                        await this.page.keyboard.press('Control+C');
                        await this.delay(300);

                        const raw = await clipboardy.read();
                        const logName = `prints/clipboard_access_key_${context.nf || 'unknown'}.txt`;
                        fs.writeFileSync(logName, raw);

                        const digits = raw.replace(/\D/g, '');
                        const matches = digits.match(/\d{44}/g) || [];

                        const isValidNFeKey = (key) => {
                            if (!/^\d{44}$/.test(key)) return false;
                            let sum = 0;
                            let weight = 2;
                            for (let i = 42; i >= 0; i--) {
                                sum += parseInt(key[i], 10) * weight;
                                weight++;
                                if (weight > 9) weight = 2;
                            }
                            const dvCalc = 11 - (sum % 11);
                            const dv = dvCalc === 0 || dvCalc === 1 ? 0 : dvCalc;
                            return dv === parseInt(key[43], 10);
                        };

                        let candidate = "";
                        for (const m of matches) {
                            if (isValidNFeKey(m)) {
                                candidate = m;
                                break;
                            }
                        }

                        if (!candidate && digits.length === 44 && isValidNFeKey(digits)) {
                            candidate = digits;
                        }

                        if (candidate) {
                            context.accessKey = candidate;
                            this.log(`✓ Access Key Captured from clipboard: ${candidate}`);
                        } else {
                            this.log(`⚠ Conteúdo do clipboard não contém chave NF-e válida. Digits length=${digits.length}.`);
                        }
                    } catch (e) {
                        this.log(`Erro ao capturar chave de acesso: ${e.message}`);
                    }
                    break;

                case 'consolidate_ocr_list':
                    this.log("Consolidating OCR results...");
                    await this.consolidateOCRList();
                    break;

                case 'extract_products':
                    this.log("Extracting products from Emissão de Etiqueta usando tesseract.js + sharp...");
                    const regionOverride = (step && typeof step.x === 'number' && typeof step.y === 'number' && step.width > 0 && step.height > 0)
                        ? { x: step.x, y: step.y, width: step.width, height: step.height }
                        : (context.lastPrintRegion || null);
                    let itensTabela = await this.extrairItensTabelaSharp(context, regionOverride);
                    if (!itensTabela || itensTabela.length === 0) {
                        this.log("Sharp OCR returned no items, falling back to grid OCR.");
                        itensTabela = await this.extrairItensTabela(context, regionOverride);
                    }
                    if (!itensTabela || itensTabela.length === 0) {
                        this.log("Grid OCR returned no items, falling back to text OCR.");
                        itensTabela = await this.extrairItensEtiqueta(context, regionOverride);
                    }
                    context.itens = itensTabela;
                    context.products = itensTabela.map(i => ({
                        raw: `${i.codFabricante} ${i.produto} ${i.localizacao} ${i.quantidade}`,
                        codigo_barras: i.codFabricante,
                        descricao: i.produto,
                        localizacao: i.localizacao,
                        quantidade: i.quantidade
                    }));
                    break;

                case 'save_invoice_data':
                    this.log("Saving invoice data...");
                    const itensToSave = context.itens || [];
                    const record = {
                        numeroNF: context.nf,
                        chaveAcesso: context.accessKey,
                        itens: itensToSave.map(i => ({
                            codFabricante: i.codFabricante,
                            produto: i.produto,
                            localizacao: i.localizacao,
                            quantidade: i.quantidade
                        })),
                        nf: context.nf,
                        accessKey: context.accessKey,
                        products: context.products,
                        timestamp: new Date().toISOString()
                    };
                    
                    // Save individual JSON
                    const safeKey = context.accessKey || `NF_${context.nf}`;
                    fs.writeFileSync(`invoice_${safeKey}.json`, JSON.stringify(record, null, 2));
                    
                    // Append to master list
                    let allData = [];
                    try {
                        if (fs.existsSync('invoice_data_loop.json')) {
                            allData = JSON.parse(fs.readFileSync('invoice_data_loop.json', 'utf8'));
                        }
                    } catch(e) {}
                    allData.push(record);
                    fs.writeFileSync('invoice_data_loop.json', JSON.stringify(allData, null, 2));
                    this.log(`✓ Data saved for NF ${context.nf}`);
                    break;
                    
                case 'click':
                default:
                    await this.visualClick(step.x, step.y);
                    break;
            }
        } catch (e) {
            this.log(`Error executing step: ${e.message}`);
            throw e;
        }

        if (this.isRecording) {
            const entry = {
                kind: 'bot_step',
                phase: context.__phase || 'unknown',
                is_loop: context.__phase === 'loop',
                index: typeof context.__index === 'number' ? context.__index : null,
                description: step.description || '',
                action: step.action || 'click',
                x: step.x,
                y: step.y,
                nf: context.nf || null,
                wait_before: step.wait_before || 0,
                wait_after: step.wait_after || 0,
                timestamp: new Date().toISOString()
            };
            this.recordedActions.push(entry);
        }

        // Check jump immediately after action (before wait_after)
        if (this.jumpToStep !== null) return { action: 'jump', index: this.jumpToStep };

        if (step.wait_after) {
            await this.delay(step.wait_after);
            // Check jump after wait_after
            if (this.jumpToStep !== null) return { action: 'jump', index: this.jumpToStep };
        }
    }

    async consolidateOCRList() {
        if (fs.existsSync('prints/all_invoices_cumulative.txt')) {
            const rawContent = fs.readFileSync('prints/all_invoices_cumulative.txt', 'utf8');
            const lines = rawContent.split('\n');
            const uniqueInvoices = new Set();
            
            lines.forEach(line => {
                const matches = line.match(/\b\d{5,9}\b/g);
                if (matches) {
                    matches.forEach(m => uniqueInvoices.add(m));
                }
            });
            
            let output = "";
            let count = 1;
            uniqueInvoices.forEach(inv => {
                output += `${count}→${inv}\n`;
                count++;
            });
            
            fs.writeFileSync('prints/final_invoice_list.txt', output);
            this.log(`✓ Consolidate Complete. Found ${uniqueInvoices.size} invoices.`);
        }
    }

    async run() {
        try {
            await this.init();

            await this.log("Navigating to login page...");
            await this.page.goto(CONFIG.url_inicial);
            
            // Login
            await this.page.fill("input[placeholder*='username'], input[placeholder*='usuário'], input[type='text']", CONFIG.credentials.user);
            await this.page.fill("input[type='password']", CONFIG.credentials.pass);
            await this.page.click("//button[contains(., 'Entrar') or contains(text(), 'Entrar')]");
            
            await this.log("Login submitted. Waiting for Vision Cloud...");
            await this.page.waitForLoadState('networkidle');
            await this.delay(5000);

            // Acessa Vision Cloud
            try {
                await this.page.click("//div[contains(., 'Vision Cloud') and not(contains(., '2.0'))]//a[contains(., 'Acessar')]");
            } catch (e) {
                this.log("Trying visual 'Vision Cloud'...");
                await this.clickText("Vision Cloud");
            }

            // Verifica nova aba
            await this.delay(3000);
            const pages = this.page.context().pages();
            if (pages.length > 1) {
                this.page = pages[pages.length - 1];
                await this.page.bringToFront();
                await this.setupControlFunctions(this.page); // RE-EXPOSE CONTROLS ON NEW PAGE
                await this.delay(2000);
            }

            // Setup Overlay
            await this.setupOverlay();

            // Executa sequência de cliques do coordinates.json
            const coords = JSON.parse(fs.readFileSync('coordinates.json', 'utf8'));
            this.currentCoordsObject = coords; // Store for saving later
            
            // 1. Setup Steps
            if (coords.setup_steps) {
                this.log("Executing Setup Steps...");
                this.currentLoopSteps = coords.setup_steps; // Set current context
                
                for (let i = 0; i < coords.setup_steps.length; i++) {
                    const step = coords.setup_steps[i];
                    const context = { __phase: 'setup', __index: i };
                    await this.updateOverlay(i, coords.setup_steps, context); // Update overlay for setup
                    
                    const result = await this.executeStep(step, context);
                    
                    // Handle Jump
                    if (result && result.action === 'jump') {
                        this.log(`Jumping to step ${result.index}`);
                        i = result.index - 1; // -1 because loop will increment
                        this.jumpToStep = null;
                    }
                }
            }

            // 2. Single-run of invoice_loop_steps (NO LOOPING)
            const loopSteps = coords.invoice_loop_steps || [];
            if (!coords.setup_steps && Array.isArray(coords)) {
                const coordsArray = coords;
                for (let i = 0; i < coordsArray.length; i++) {
                    await this.updateOverlay(i, coordsArray);
                    await this.executeStep(coordsArray[i]);
                }
            } else if (loopSteps.length > 0) {
                let invoiceList = [];
                try {
                    if (fs.existsSync('prints/final_invoice_list.txt')) {
                        const rawList = fs.readFileSync('prints/final_invoice_list.txt', 'utf8');
                        const lines = rawList.split('\n');
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            const parts = trimmed.split('→');
                            const nf = (parts[1] || parts[0]).trim();
                            if (nf) invoiceList.push(nf);
                        }
                    }
                } catch (e) {
                    this.log(`Erro ao ler lista de NFs: ${e.message}`);
                }

                if (invoiceList.length === 0) {
                    const context = { nf: '', products: [], __phase: 'loop' };
                    this.currentLoopSteps = loopSteps;
                    try {
                        for (let j = 0; j < loopSteps.length; j++) {
                            const currentStep = JSON.parse(JSON.stringify(loopSteps[j]));
                            context.__index = j;
                            await this.updateOverlay(j, loopSteps, context);
                            const result = await this.executeStep(currentStep, context);
                            if (result && result.action === 'jump') {
                                this.log(`Jumping to step ${result.index}`);
                                j = result.index - 1;
                                this.jumpToStep = null;
                            }
                        }
                        this.isPaused = true;
                        this.log("Fluxo único concluído. Aguardando ação para gravar.");
                    } catch(e) {
                        this.log(`Erro durante execução única: ${e.message}`);
                    }
                } else {
                    this.currentLoopSteps = loopSteps;
                    for (let idx = 0; idx < invoiceList.length; idx++) {
                        const nfNumber = invoiceList[idx];
                        const context = { nf: nfNumber, products: [], __phase: 'loop' };
                        this.log(`Iniciando fluxo da NF ${nfNumber} (${idx + 1}/${invoiceList.length})`);
                        try {
                            for (let j = 0; j < loopSteps.length; j++) {
                                const currentStep = JSON.parse(JSON.stringify(loopSteps[j]));
                                context.__index = j;
                                await this.updateOverlay(j, loopSteps, context);
                                const result = await this.executeStep(currentStep, context);
                                if (result && result.action === 'jump') {
                                    this.log(`Jumping to step ${result.index}`);
                                    j = result.index - 1;
                                    this.jumpToStep = null;
                                }
                            }
                        } catch (e) {
                            this.log(`Erro durante execução da NF ${nfNumber}: ${e.message}`);
                        }
                    }
                    this.isPaused = true;
                    this.log("Loop de NFs concluído. Aguardando ação para gravar.");
                }
            }

            this.log("\n🎉 DONE (single-run)!");

        } catch (error) {
            this.log(`Error during visual automation: ${error.message}`);
            console.error("Error during visual automation:", error);
            // Take screenshot on error
            if (this.page) await this.page.screenshot({ path: 'error_screenshot.png' });
        } finally {
            if (this.worker) {
                await this.worker.terminate();
            }
            // await this.browser.close();
        }
    }
}

// Execute
(new VisionBot()).run();
