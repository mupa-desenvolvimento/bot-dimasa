const fs = require('fs');
const Tesseract = require('tesseract.js');

async function analyze() {
    console.log("Analyzing debug images...");
    
    const files = ['debug_last_ocr.png', 'debug_header_search.png', 'debug_scroll_1_roi.png'];
    
    const worker = await Tesseract.createWorker('eng'); // 'eng' usually works for numbers too
    
    for (const file of files) {
                if (fs.existsSync(file)) {
                    console.log(`\n--- Analyzing ${file} ---`);
                    // Try default first
                    console.log("--- Default Parameters ---");
                    await worker.setParameters({});
                    let ret = await worker.recognize(file);
                    console.log(`Text: "${ret.data.text.replace(/\n/g, ' ')}"`);
                    console.log(`Blocks: ${ret.data.blocks ? ret.data.blocks.length : 0}`);

                    const psms = [3, 4, 6, 11, 12];
            
            for (const psm of psms) {
                        await worker.setParameters({
                            tessedit_pageseg_mode: psm,
                            tessedit_create_tsv: '1',
                            tessedit_create_hocr: '1',
                            tessedit_create_box: '1'
                        });
                        const ret = await worker.recognize(file);
                        console.log(`[PSM ${psm}] Text: "${ret.data.text.replace(/\n/g, ' ').substring(0, 100)}..."`);
                        console.log(`  HOCR type: ${typeof ret.data.hocr}, length: ${ret.data.hocr ? ret.data.hocr.length : 0}`);
                        console.log(`  TSV type: ${typeof ret.data.tsv}, length: ${ret.data.tsv ? ret.data.tsv.length : 0}`);
                        console.log(`  BOX type: ${typeof ret.data.box}, length: ${ret.data.box ? ret.data.box.length : 0}`);

                        
                        let allWords = [];
                        // Check layoutBlocks too
                        if (ret.data.layoutBlocks) {
                             console.log(`  layoutBlocks count: ${ret.data.layoutBlocks.length}`);
                        }
                        if (ret.data.blocks) {
                            ret.data.blocks.forEach(block => {
                                if (block.paragraphs) {
                                    block.paragraphs.forEach(para => {
                                        if (para.lines) {
                                            para.lines.forEach(line => {
                                                if (line.words) {
                                                    allWords.push(...line.words);
                                                }
                                            });
                                        }
                                    });
                                }
                            });
                        }

                        console.log(`  Word count: ${allWords.length}`);

                        if (allWords.length > 0) {
                             allWords.forEach(w => {
                                 const txt = w.text.replace(/\D/g, '');
                                 if (txt.length >= 5 && txt.length <= 12) {
                                     console.log(`  Found potential invoice: ${w.text} at X=${w.bbox.x0}, Y=${w.bbox.y0}`);
                                 }
                             });
                        }
                    }
        } else {
            console.log(`${file} does not exist.`);
        }
    }
    
    await worker.terminate();
}

analyze();