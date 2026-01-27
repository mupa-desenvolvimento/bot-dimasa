const { Jimp } = require('jimp');
const fs = require('fs');

console.log('Jimp class:', Jimp);

async function test() {
    console.log("Reading debug_last_ocr.png...");
    if (!fs.existsSync('debug_last_ocr.png')) {
        console.log("File not found.");
        return;
    }

    const image = await Jimp.read('debug_last_ocr.png');
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    console.log(`Image size: ${width}x${height}`);

    const histogram = new Array(height).fill(0);

    image.scan(0, 0, width, height, function(x, y, idx) {
        // x, y is the position of this pixel on the image
        // idx is the position start position of this rgba byte in the bitmap Buffer
        // this is the image

        const red = this.bitmap.data[idx + 0];
        const green = this.bitmap.data[idx + 1];
        const blue = this.bitmap.data[idx + 2];

        // Simple grayscale
        const gray = (red + green + blue) / 3;

        // Assuming dark text on light background
        if (gray < 200) { // Threshold for "dark"
            histogram[y]++;
        }
    });

    // Find segments
    const lines = [];
    let inLine = false;
    let startY = 0;
    
    // Threshold for a line to be considered "text" (e.g., at least 30 dark pixels in the row)
    const pixelThreshold = 30;

    let maxDarkPixels = 0;
    for(let y=0; y<height; y++) {
        if (histogram[y] > maxDarkPixels) maxDarkPixels = histogram[y];
    }
    console.log(`Max dark pixels in a row: ${maxDarkPixels}`);

    for (let y = 0; y < height; y++) {
        if (histogram[y] > pixelThreshold) {
            if (!inLine) {
                inLine = true;
                startY = y;
            }
        } else {
            if (inLine) {
                inLine = false;
                // End of line
                if (y - startY > 10) { 
                    lines.push({ y: startY, height: y - startY });
                }
            }
        }
    }
    // Check end
    if (inLine) {
        if (height - startY > 10) {
            lines.push({ y: startY, height: height - startY });
        }
    }
    
    // Test Crop
    try {
        const cropTest = image.clone().crop({ x: 0, y: 0, w: 100, h: 100 });
        console.log("Crop with object works");
    } catch (e) {
        console.log("Crop with object failed:", e.message);
    }

    try {
        const cropTest2 = image.clone().crop(0, 0, 100, 100);
        console.log("Crop with args works");
    } catch (e) {
        console.log("Crop with args failed:", e.message);
    }
}

test();