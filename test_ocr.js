const { chromium } = require('playwright');
const Tesseract = require('tesseract.js');

(async () => {
    console.log('Starting OCR test...');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Create a simple HTML page with text to test
    await page.setContent(`
        <html>
            <body style="background: white; display: flex; justify-content: center; align-items: center; height: 100vh;">
                <h1 style="font-size: 48px;">Faturamento</h1>
                <p style="font-size: 24px; position: absolute; top: 100px; left: 100px;">Entrada</p>
            </body>
        </html>
    `);
    
    console.log('Taking screenshot...');
    const buffer = await page.screenshot();
    
    console.log('Initializing Tesseract...');
    const worker = await Tesseract.createWorker('eng');
    
    console.log('Recognizing text...');
    const result = await worker.recognize(buffer);
    const data = result.data;
    
    console.log('Result Keys:', Object.keys(data));
    console.log('Result Text:', data.text);
    if (data.words) {
        console.log('Found words:', data.words.length);
    } else {
        console.log('No words array found directly in data.');
    }
    
    if (data.text.includes('Faturamento')) {
        console.log('SUCCESS: "Faturamento" found!');
    } else {
        console.error('FAILURE: "Faturamento" not found.');
    }
    
    await worker.terminate();
    await browser.close();
})();
