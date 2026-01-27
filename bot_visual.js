const { chromium } = require('playwright');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

// Configuration
const CONFIG = {
    url_inicial: 'https://workspace.sisand.com.br/login',
    credentials: {
        user: '089.jeanp',
        pass: 'Dimasa1379@'
    },
};

class VisionBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.worker = null;
        this.scaleFactor = 1;
        this.shouldStop = false;
        this.shouldRestart = false;
        this.currentInvoiceData = {};
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
        return new Promise(resolve => setTimeout(resolve, ms));
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
            dot.style.left = `${x - 5}px`;
            dot.style.top = `${y - 5}px`;
            dot.style.width = '10px';
            dot.style.height = '10px';
            dot.style.backgroundColor = 'red';
            dot.style.borderRadius = '50%';
            dot.style.zIndex = '999999';
            dot.style.pointerEvents = 'none';
            document.body.appendChild(dot);
            setTimeout(() => dot.remove(), 1000);
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

        const screenshotBuffer = await this.page.screenshot({ clip: region });
        const { data } = await this.worker.recognize(screenshotBuffer);
        
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
        return [];
    }

    async getTextInRegion(region, psm = '3') {
        await this.worker.setParameters({
            tessedit_pageseg_mode: psm,
        });
        const screenshotBuffer = await this.page.screenshot({ clip: region });
        const { data } = await this.worker.recognize(screenshotBuffer);
        return data.text.toLowerCase();
    }

    async setupOverlay() {
        if (this._consoleHandler) {
            this.page.removeListener('console', this._consoleHandler);
        }
        this._consoleHandler = msg => {
            const text = msg.text();
            if (text === '__BOT_STOP__') {
                this.log('🛑 STOP COMMAND RECEIVED');
                this.shouldStop = true;
            }
            if (text === '__BOT_RESTART__') {
                this.log('🔄 RESTART COMMAND RECEIVED');
                this.shouldRestart = true;
            }
        };
        this.page.on('console', this._consoleHandler);

        await this.page.evaluate(() => {
            const overlay = document.createElement('div');
            overlay.id = 'bot-overlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '10px';
            overlay.style.right = '10px';
            overlay.style.width = '300px';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
            overlay.style.color = '#fff';
            overlay.style.padding = '15px';
            overlay.style.borderRadius = '8px';
            overlay.style.fontFamily = 'Arial, sans-serif';
            overlay.style.fontSize = '12px';
            overlay.style.zIndex = '9999999';
            overlay.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
            document.body.appendChild(overlay);
        });
    }

    async clearHighlight() {
        try {
            await this.page.evaluate(() => {
                const el = document.getElementById('bot-highlight');
                if (el) el.remove();
            });
        } catch (e) {}
    }

    async showRegionHighlight(x, y, width, height, color = 'rgba(255, 255, 0, 0.3)') {
        try {
            await this.clearHighlight();
            await this.page.evaluate(({x, y, width, height, color}) => {
                const el = document.createElement('div');
                el.id = 'bot-highlight';
                el.style.position = 'fixed';
                el.style.left = `${x}px`;
                el.style.top = `${y}px`;
                el.style.width = `${width}px`;
                el.style.height = `${height}px`;
                el.style.backgroundColor = color;
                el.style.border = '2px solid yellow';
                el.style.zIndex = '9999998';
                el.style.pointerEvents = 'none';
                document.body.appendChild(el);
            }, {x, y, width, height, color});
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

    async showDragHighlight(startX, startY, endX, endY) {
         // Simplified drag highlight
         // (Implementation from original code omitted for brevity but can be added if needed)
    }

    async updateOverlay(currentIndex, steps) {
        try {
            await this.clearDragHighlight();
            const currentStep = steps[currentIndex];
            if (currentStep && currentStep.width && currentStep.height) {
                await this.showRegionHighlight(currentStep.x, currentStep.y, currentStep.width, currentStep.height);
            } else {
                await this.clearHighlight();
            }

            await this.page.evaluate(({ currentIndex, steps }) => {
                const overlay = document.getElementById('bot-overlay');
                if (!overlay) return;

                let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #555; padding-bottom:5px;">';
                html += '<h3 style="margin:0; font-size:14px; color:#fff;">Bot Control</h3>';
                html += '<div style="display:flex; gap:5px;">';
                html += '<button onclick="console.log(\'__BOT_STOP__\')" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">⏹ STOP</button>';
                html += '<button onclick="console.log(\'__BOT_RESTART__\')" style="background:#ffc107; color:black; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">🔄 RESTART</button>';
                html += '</div></div>';
                
                // Current
                if (currentIndex < steps.length) {
                    html += `<div style="color:#fff; font-weight:bold; background:rgba(40, 167, 69, 0.2); border-left: 3px solid #28a745; padding:8px; border-radius:4px; margin-bottom:10px;">`;
                    html += `<div style="font-size:10px; color:#28a745; text-transform:uppercase;">EXECUTING NOW</div>`;
                    html += `➤ ${currentIndex + 1}. ${steps[currentIndex].description}`;
                    html += `</div>`;
                } else {
                    html += `<div style="color:#fff; font-weight:bold; background:rgba(40, 167, 69, 0.2); padding:8px; border-radius:4px; margin-bottom:10px;">✓ ALL TASKS COMPLETED</div>`;
                }
                overlay.innerHTML = html;
            }, { currentIndex, steps });
        } catch (e) {}
    }

    // =========================================================================
    // NEW METHODS FOR INVOICE LOOP
    // =========================================================================

    async loadInvoiceList() {
        this.log("Loading invoice list from file...");
        try {
            const listPath = path.join(__dirname, 'prints', 'final_invoice_list.txt');
            if (fs.existsSync(listPath)) {
                const content = fs.readFileSync(listPath, 'utf8');
                const list = content.split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !isNaN(parseInt(l)));
                this.log(`Loaded ${list.length} invoices to process: ${list.join(', ')}`);
                return list;
            }
        } catch (e) {
            this.log(`Error loading invoice list: ${e.message}`);
        }
        return [];
    }

    getInvoiceSteps(nfNumber) {
        if (!this.loopTemplate) {
            return [];
        }

        return this.loopTemplate.map(step => {
            const newStep = { ...step };
            for (const key in newStep) {
                if (typeof newStep[key] === 'string') {
                    newStep[key] = newStep[key].replace(/{{nf}}/g, nfNumber);
                }
            }
            return newStep;
        });
    }

    async executeAction(step, i) {
        this.log(`Executing Step ${i + 1}: ${step.description} [Action: ${step.action}]`);
        
        if (step.wait_before) await this.delay(step.wait_before);

        switch (step.action) {
            case 'click':
                await this.visualClick(step.x, step.y);
                break;
            case 'double_click':
                await this.visualClick(step.x, step.y, { doubleClick: true });
                break;
            case 'type':
                if (step.x && step.y) await this.visualClick(step.x, step.y);
                await this.page.keyboard.type(step.text, { delay: 100 });
                break;
            case 'keypress':
                if (step.key === 'SelectAll_Delete') {
                    await this.page.keyboard.press('Control+A');
                    await this.delay(100);
                    await this.page.keyboard.press('Delete');
                } else {
                    await this.page.keyboard.press(step.key);
                }
                break;
            case 'wait_for_text':
                try {
                    await this.findElementByText(step.text, { retries: Math.ceil((step.timeout || 5000) / 2000) });
                } catch(e) {
                    this.log(`Warning: Text '${step.text}' not found.`);
                }
                break;
            case 'conditional_click':
                try {
                    const found = await this.findElementByText(step.check_text, { retries: 1 });
                    if (found) {
                        await this.clickText(step.click_text);
                    }
                } catch(e) {}
                break;
            case 'extract_table_items':
                this.log("Extracting table items (Simulation)...");
                this.currentInvoiceData = this.currentInvoiceData || {};
                this.currentInvoiceData.items = [{ code: '001', desc: 'Item Simulado', qty: 1 }];
                break;
            case 'ocr_region':
                const text = await this.getTextInRegion({ x: step.x, y: step.y, width: step.width, height: step.height }, step.psm);
                this.log(`OCR Result: ${text}`);
                if (step.save_key) {
                    this.currentInvoiceData = this.currentInvoiceData || {};
                    this.currentInvoiceData[step.save_key] = text.trim();
                }
                break;
            case 'save_json':
                const filename = `output/${step.nf}.json`;
                try { fs.mkdirSync('output', { recursive: true }); } catch(e){}
                fs.writeFileSync(filename, JSON.stringify(this.currentInvoiceData || {}, null, 2));
                this.log(`Saved JSON to ${filename}`);
                this.currentInvoiceData = {}; 
                break;
            case 'screenshot_region':
                const shotName = step.filename || `prints/region_${Date.now()}.png`;
                await this.page.screenshot({ path: shotName, clip: { x: step.x, y: step.y, width: step.width, height: step.height } });
                break;
            case 'drag':
                 await this.page.mouse.move(step.startX, step.startY);
                 await this.page.mouse.down();
                 await this.delay(300);
                 await this.page.mouse.move(step.endX, step.endY, { steps: 20 });
                 await this.delay(300);
                 await this.page.mouse.up();
                 break;
            default:
                if(step.action) this.log(`Unknown action: ${step.action}`);
        }

        if (step.wait_after) await this.delay(step.wait_after);
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
            await this.page.waitForLoadState('networkidle');
            await this.delay(5000);

            try {
                await this.page.click("//div[contains(., 'Vision Cloud') and not(contains(., '2.0'))]//a[contains(., 'Acessar')]");
            } catch (e) {
                await this.clickText("Vision Cloud");
            }
            await this.delay(3000);
            const pages = this.page.context().pages();
            if (pages.length > 1) {
                this.page = pages[pages.length - 1];
                await this.page.bringToFront();
                await this.delay(2000);
            }

            await this.setupOverlay();

                  // 1. Initial Navigation
                  const coordsRaw = fs.readFileSync('coordinates.json', 'utf8');
                  let coords;
                  try {
                      coords = JSON.parse(coordsRaw);
                  } catch (e) {
                      this.log("Error parsing coordinates.json");
                      coords = {};
                  }

                  let setupSteps = [];
                  if (Array.isArray(coords)) {
                      setupSteps = coords.slice(0, 5);
                      this.loopTemplate = [];
                  } else {
                      setupSteps = coords.setup_steps || [];
                      this.loopTemplate = coords.invoice_loop_steps || [];
                  }
                  
                  for (let i = 0; i < setupSteps.length; i++) {
                await this.updateOverlay(i, setupSteps);
                await this.executeAction(setupSteps[i], i);
            }

            // 2. Load Invoice List
            const invoiceList = await this.loadInvoiceList();
            
            // 3. Process Loop
            for (let i = 0; i < invoiceList.length; i++) {
                const nf = invoiceList[i];
                this.log(`\n=== Processing Invoice ${i+1}/${invoiceList.length}: ${nf} ===`);
                
                const steps = this.getInvoiceSteps(nf);
                
                for (let j = 0; j < steps.length; j++) {
                    if (this.shouldStop) {
                         this.log('🛑 BOT STOPPED BY USER.');
                         return; 
                    }
                    if (this.shouldRestart) {
                        this.log('🔄 RESTARTING...');
                        this.shouldRestart = false;
                        i = -1; 
                        break;
                    }

                    await this.updateOverlay(j, steps);
                    try {
                        await this.executeAction(steps[j], j);
                    } catch (e) {
                        this.log(`❌ Step failed: ${e.message}`);
                        break; 
                    }
                }
            }

            this.log("\n🎉 ALL DONE!");

        } catch (error) {
            this.log(`Error: ${error.message}`);
        } finally {
            if (this.worker) await this.worker.terminate();
        }
    }
}

(new VisionBot()).run();
