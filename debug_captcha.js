const { chromium } = require('playwright');
const fs = require('fs');

(async function() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  fs.mkdirSync('artifacts', { recursive: true });
  
  await page.goto('https://gpt.qt.cool/checkin', { waitUntil: 'networkidle', timeout: 30000 });
  
  const captchaData = await page.evaluate(async () => {
    const r = await fetch('/auth/captcha?mode=slider', { cache: 'no-store' });
    return await r.json();
  });
  
  const data = captchaData.data;
  console.log('width:', data.width, 'pieceSize:', data.pieceSize);
  
  const result = await page.evaluate(({ bgUrl, width, pieceSize, y }) => {
    return new Promise((resolve) => {
      const bgImg = new Image();
      bgImg.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = bgImg.naturalHeight || 160;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bgImg, 0, 0, width, canvas.height);
        const imgData = ctx.getImageData(0, 0, width, canvas.height);
        const d = imgData.data;
        
        // Method 1: Column intensity sums (grayscale)
        const colSum = new Array(width).fill(0);
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let row = 0; row < canvas.height; row++) {
            const idx = (row * width + x) * 4;
            sum += d[idx] * 0.299 + d[idx+1] * 0.587 + d[idx+2] * 0.114;
          }
          colSum[x] = sum / canvas.height;
        }
        
        // Method 2: Column difference (consecutive)
        const colDiff = new Array(width - 1).fill(0);
        for (let x = 0; x < width - 1; x++) {
          colDiff[x] = Math.abs(colSum[x] - colSum[x + 1]);
        }
        
        // Find peaks in column differences
        const peaks = [];
        for (let x = 1; x < width - 2; x++) {
          if (colDiff[x] > colDiff[x-1] && colDiff[x] > colDiff[x+1]) {
            peaks.push({ x, value: colDiff[x] });
          }
        }
        peaks.sort((a, b) => b.value - a.value);
        
        // Method 3: Edge detection on gap region (y to y+pieceSize)
        const startRow = y || 0;
        const endRow = Math.min(startRow + pieceSize, canvas.height);
        const gapColSum = new Array(width).fill(0);
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let row = startRow; row < endRow; row++) {
            const idx = (row * width + x) * 4;
            sum += d[idx] * 0.299 + d[idx+1] * 0.587 + d[idx+2] * 0.114;
          }
          gapColSum[x] = sum / (endRow - startRow);
        }
        
        const gapColDiff = new Array(width - 1).fill(0);
        for (let x = 0; x < width - 1; x++) {
          gapColDiff[x] = Math.abs(gapColSum[x] - gapColSum[x + 1]);
        }
        
        const gapPeaks = [];
        for (let x = 1; x < width - 2; x++) {
          if (gapColDiff[x] > gapColDiff[x-1] && gapColDiff[x] > gapColDiff[x+1]) {
            gapPeaks.push({ x, value: gapColDiff[x] });
          }
        }
        gapPeaks.sort((a, b) => b.value - a.value);
        
        resolve({ colSum, colDiff, peaks: peaks.slice(0, 10), gapColSum, gapColDiff, gapPeaks: gapPeaks.slice(0, 10) });
      };
      bgImg.src = bgUrl;
    });
  }, { bgUrl: data.bg, width: data.width, pieceSize: data.pieceSize || 52, y: data.y || 0 });
  
  console.log('\nTop column diff peaks:');
  result.peaks.forEach(p => console.log('  x=' + p.x + ' diff=' + p.value.toFixed(1)));
  
  console.log('\nTop gap region diff peaks:');
  result.gapPeaks.forEach(p => console.log('  x=' + p.x + ' diff=' + p.value.toFixed(1)));
  
  // Save column diff data for plotting
  const csvLines = ['x,full_diff,gap_diff'];
  for (let x = 0; x < result.colDiff.length; x++) {
    csvLines.push(x + ',' + result.colDiff[x].toFixed(2) + ',' + (result.gapColDiff[x] || 0).toFixed(2));
  }
  fs.writeFileSync('artifacts/col_diff.csv', csvLines.join('\n'));
  
  await browser.close();
  console.log('\nDone. Check artifacts/col_diff.csv');
})();