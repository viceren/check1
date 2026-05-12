require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHECKIN_KEY = process.env.CHECKIN_KEY;
if (!CHECKIN_KEY) {
  console.error('未设置CHECKIN_KEY环境变量');
  process.exit(1);
}

const CHECKIN_URL = 'https://gpt.qt.cool/checkin';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || 'artifacts';

async function saveScreenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
    console.log('📸 截图: ' + name);
  } catch (e) {}
}

async function injectSolver(page) {
  await page.evaluate(() => {
    async function _loadImage(url) {
      return new Promise(function(resolve, reject) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() { resolve(img); };
        img.onerror = function() {
          fetch(url).then(function(r) { return r.blob(); }).then(function(b) {
            var dataUrl = URL.createObjectURL(b);
            var img2 = new Image();
            img2.onload = function() { resolve(img2); };
            img2.onerror = reject;
            img2.src = dataUrl;
          }).catch(reject);
        };
        img.src = url;
      });
    }

    async function _findGap(bgUrl, width, pieceSize, gapY) {
      var bgImg = await _loadImage(bgUrl);

      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = bgImg.naturalHeight || 160;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bgImg, 0, 0, width, canvas.height);
      var imgData = ctx.getImageData(0, 0, width, canvas.height);
      var d = imgData.data;
      var h = canvas.height;

      var startRow = Math.max(0, gapY - 10);
      var endRow = Math.min(h, gapY + pieceSize + 10);
      var colSum = new Array(width);
      for (var x = 0; x < width; x++) {
        var sum = 0;
        for (var row = startRow; row < endRow; row++) {
          var idx = (row * width + x) * 4;
          sum += d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
        }
        colSum[x] = sum / (endRow - startRow);
      }

      var colDiff = new Array(width - 1);
      for (var x = 0; x < width - 1; x++) {
        colDiff[x] = Math.abs(colSum[x] - colSum[x + 1]);
      }

      var peaks = [];
      for (var x = 1; x < width - 2; x++) {
        if (colDiff[x] > colDiff[x - 1] && colDiff[x] > colDiff[x + 1]) {
          peaks.push({ x: x, value: colDiff[x] });
        }
      }
      peaks.sort(function(a, b) { return b.value - a.value; });

      var LIMIT = Math.min(peaks.length, 20);
      var pairFound = false;
      for (var i = 0; i < LIMIT; i++) {
        for (var j = i + 1; j < LIMIT; j++) {
          var dist = Math.abs(peaks[i].x - peaks[j].x);
          if (Math.abs(dist - pieceSize) <= 8) {
            var left = Math.min(peaks[i].x, peaks[j].x);
            var right = Math.max(peaks[i].x, peaks[j].x);
            console.log('[CaptchaSolver] gap edges: left=' + left + ' right=' + right + ' dist=' + dist + ' ps=' + pieceSize);
            pairFound = true;
            return left;
          }
        }
      }

      if (peaks.length > 0) return peaks[0].x;
      return 0;
    }

    window._originalRunSliderCaptcha = window.runSliderCaptcha;
    window.runSliderCaptcha = async function(opts) {
      opts = opts || {};
      try {
        var r = await fetch('/auth/captcha?mode=slider', { cache: 'no-store' });
        var d = await r.json();
        if (d.code !== 0 || !d.data || !d.data.slider) throw new Error('captcha unavailable');
        var data = d.data;

        var gapX = await _findGap(data.bg, data.width, data.pieceSize || 52, data.y || 0);
        console.log('[CaptchaSolver] gap=' + gapX);

        var totalTime = 600 + Math.floor(Math.random() * 400);
        var steps = 30 + Math.floor(Math.random() * 15);
        var points = [];
        var baseY = data.y || 0;

        for (var i = 0; i <= steps; i++) {
          var progress = i / steps;
          var eased = progress < 0.8
            ? progress * (1 + (Math.random() - 0.5) * 0.3)
            : 1 - Math.pow(1 - progress, 3);
          var x = Math.round(eased * gapX);
          var t = Math.round(progress * totalTime);
          var y = Math.round(baseY + (Math.random() - 0.5) * 12);
          points.push(t + ':' + x + ':' + y);
        }
        points[points.length - 1] = totalTime + ':' + gapX + ':' + baseY;

        return {
          sliderId: data.id,
          sliderX: gapX,
          sliderTrack: points.join(';')
        };
      } catch (e) {
        console.log('[CaptchaSolver] error: ' + e);
        return null;
      }
    };
  });
}

async function autoCheckin() {
  let browser = null;

  try {
    console.log('🚀 自动签到启动');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    page.on('console', function(msg) {
      var t = msg.text();
      if (t.indexOf('[CaptchaSolver]') !== -1) console.log('  ' + t);
    });

    console.log('访问: ' + CHECKIN_URL);
    await page.goto(CHECKIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, '01_initial.png');

    await injectSolver(page);
    console.log('🔧 滑块求解器已注入');

    console.log('🔐 登录中...');
    await page.locator('#renewKey').fill(CHECKIN_KEY);
    await saveScreenshot(page, '02_after_input.png');

    await page.locator('#renewLogin button.ci-btn.renew').click({ timeout: 5000 });

    try {
      await page.locator('#renewCheckin').waitFor({ state: 'visible', timeout: 15000 });
      console.log('✅ 登录成功');
    } catch (e) {
      console.error('登录超时');
      await saveScreenshot(page, '03_login_failed.png');
      return false;
    }

    await page.waitForTimeout(3000);
    await saveScreenshot(page, '03_after_login.png');

    const checkinBtn = page.locator('#checkinBtn');
    const btnText = await checkinBtn.textContent().catch(function() { return ''; });
    const btnDisabled = await checkinBtn.isDisabled().catch(function() { return true; });
    console.log('签到按钮: "' + btnText + '" disabled=' + btnDisabled);

    if (btnText.indexOf('今日已签到') !== -1 || btnDisabled) {
      console.log('✅ 今日已签到');
      await saveScreenshot(page, '04_already_checked.png');
      return true;
    }

    console.log('📝 开始签到...');
    await checkinBtn.click({ timeout: 5000 });

    try {
      await page.waitForFunction(function() {
        var btn = document.getElementById('checkinBtn');
        if (!btn) return true;
        return btn.textContent.indexOf('今日已签到') !== -1 || btn.disabled;
      }, { timeout: 30000 });
    } catch (e) {
      console.log('签到按钮状态未变化');
    }

    await page.waitForTimeout(3000);
    await saveScreenshot(page, '04_after_checkin.png');

    const finalBtnText = await checkinBtn.textContent().catch(function() { return ''; });
    const finalDisabled = await checkinBtn.isDisabled().catch(function() { return true; });
    console.log('最终按钮: "' + finalBtnText + '" disabled=' + finalDisabled);

    if (finalBtnText.indexOf('今日已签到') !== -1 || finalDisabled) {
      console.log('✅ 签到成功');
      return true;
    }

    const resultText = await page.locator('#renewResult').textContent().catch(function() { return ''; });
    console.log('结果消息: ' + resultText);

    if (resultText.indexOf('成功') !== -1 || resultText.indexOf('已签到') !== -1) {
      console.log('✅ 签到成功');
      return true;
    }

    if (resultText.indexOf('人机验证') !== -1 || resultText.indexOf('请完成') !== -1) {
      console.log('❌ 验证码求解失败');
      return false;
    }

    console.log('流程结束');
    await saveScreenshot(page, '04_final.png');
    return true;

  } catch (error) {
    console.error('错误: ' + error.message);
    if (browser) {
      try {
        var pages = await browser.pages();
        if (pages.length > 0) await saveScreenshot(pages[0], 'error.png');
      } catch (e) {}
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log('浏览器已关闭');
    }
  }
}

(async function() {
  try {
    console.log('========== 签到测试 ==========');
    var success = await autoCheckin();
    if (success) {
      console.log('✅ 签到成功');
      process.exit(0);
    } else {
      console.log('❌ 签到失败');
      process.exit(1);
    }
  } catch (error) {
    console.error('签到失败: ' + error.message);
    process.exit(1);
  }
})();