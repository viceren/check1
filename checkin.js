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
    function _loadImage(url) {
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

    function _findGap(bgUrl, width, pieceSize, gapY) {
      return _loadImage(bgUrl).then(function(bgImg) {
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = bgImg.naturalHeight || 160;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bgImg, 0, 0, width, canvas.height);
        var imgData = ctx.getImageData(0, 0, width, canvas.height);
        var d = imgData.data;
        var h = canvas.height;

        var startRow = Math.max(0, gapY - 5);
        var endRow = Math.min(h, gapY + pieceSize + 5);
        if (endRow - startRow < 10) { startRow = 0; endRow = h; }
        var scanHeight = endRow - startRow;

        var edges = new Float64Array(width);
        for (var x = 0; x < width; x++) {
          var sum = 0;
          for (var row = startRow; row < endRow; row++) {
            for (var c = -1; c <= 1; c++) {
              var px = Math.min(Math.max(x + c, 0), width - 1);
              var idx = (row * width + px) * 4;
              var gray = d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
              sum += gray * (c === 0 ? 0 : (c < 0 ? -1 : 1));
            }
          }
          edges[x] = Math.abs(sum) / (scanHeight * 2);
        }

        var smoothed = new Float64Array(width);
        for (var x = 2; x < width - 2; x++) {
          smoothed[x] = (edges[x - 2] + edges[x - 1] * 2 + edges[x] * 3 + edges[x + 1] * 2 + edges[x + 2]) / 9;
        }
        for (var x = 2; x < width - 2; x++) {
          edges[x] = smoothed[x];
        }

        var threshold = 0;
        var count = 0;
        for (var x = 0; x < width; x++) {
          if (edges[x] > threshold) { threshold += edges[x]; count++; }
        }
        threshold = count > 0 ? (threshold / count) * 0.6 : 0;

        var peaks = [];
        for (var x = 2; x < width - 2; x++) {
          if (edges[x] > threshold && edges[x] > edges[x - 1] && edges[x] > edges[x + 1]
            && edges[x] >= edges[x - 2] && edges[x] >= edges[x + 2]) {
            peaks.push({ x: x, value: edges[x] });
          }
        }
        peaks.sort(function(a, b) { return b.value - a.value; });

        console.log('[CaptchaSolver] width=' + width + ' pieceSize=' + pieceSize + ' peaks=' + peaks.length + ' threshold=' + threshold.toFixed(1));

        var LIMIT = Math.min(peaks.length, 15);
        for (var i = 0; i < LIMIT; i++) {
          for (var j = i + 1; j < LIMIT; j++) {
            var dist = Math.abs(peaks[i].x - peaks[j].x);
            if (Math.abs(dist - pieceSize) <= 6) {
              var left = Math.min(peaks[i].x, peaks[j].x);
              var right = Math.max(peaks[i].x, peaks[j].x);
              console.log('[CaptchaSolver] gap pair: left=' + left + ' right=' + right + ' dist=' + dist + ' ps=' + pieceSize);
              return left;
            }
          }
        }

        if (peaks.length > 1) {
          var d1 = Math.abs(peaks[0].x - peaks[1].x);
          if (Math.abs(d1 - pieceSize) <= 10) {
            var left = Math.min(peaks[0].x, peaks[1].x);
            console.log('[CaptchaSolver] gap top2: left=' + left + ' right=' + Math.max(peaks[0].x, peaks[1].x) + ' dist=' + d1);
            return left;
          }
        }

        if (peaks.length > 0) {
          console.log('[CaptchaSolver] fallback peak: x=' + peaks[0].x + ' val=' + peaks[0].value.toFixed(1));
          return peaks[0].x;
        }
        return Math.round(width * 0.3);
      });
    }

    window._originalRunSliderCaptcha = window.runSliderCaptcha;
    window.runSliderCaptcha = async function(opts) {
      opts = opts || {};
      try {
        var r = await fetch('/auth/captcha?mode=slider', { cache: 'no-store' });
        var d = await r.json();
        if (d.code !== 0 || !d.data || !d.data.slider) {
          console.log('[CaptchaSolver] captcha unavailable, trying fallback');
          var fr = await fetch('/auth/captcha?mode=slider&t=' + Date.now(), { cache: 'no-store' });
          var fd = await fr.json();
          if (fd.code !== 0 || !fd.data || !fd.data.slider) throw new Error('captcha unavailable');
          d = fd;
        }
        var data = d.data;

        var gapX = await _findGap(data.bg, data.width, data.pieceSize || 52, data.y || 0);
        console.log('[CaptchaSolver] gap=' + gapX);

        var totalTime = 600 + Math.floor(Math.random() * 400);
        var steps = 30 + Math.floor(Math.random() * 15);
        var points = [];
        var baseY = data.y || 0;

        for (var i = 0; i <= steps; i++) {
          var progress = i / steps;
          var eased;
          if (progress < 0.3) {
            eased = progress * 0.4 + (Math.random() - 0.5) * 0.05;
          } else if (progress < 0.7) {
            eased = 0.12 + (progress - 0.3) * 1.2 + (Math.random() - 0.5) * 0.08;
          } else {
            eased = 0.6 + (progress - 0.7) * 1.333 + (Math.random() - 0.5) * 0.03;
          }
          eased = Math.min(1, Math.max(0, eased));
          var x = Math.round(eased * gapX);
          var t = Math.round(progress * totalTime);
          var y = Math.round(baseY + (Math.random() - 0.5) * 10);
          points.push(t + ':' + x + ':' + y);
        }

        var overshoot = gapX + 2 + Math.floor(Math.random() * 4);
        var undershoot = gapX;
        var finalTime = totalTime + 80 + Math.floor(Math.random() * 60);
        points[points.length - 1] = totalTime + ':' + overshoot + ':' + baseY;
        points.push((totalTime + 40) + ':' + overshoot + ':' + baseY);
        points.push((totalTime + 80) + ':' + undershoot + ':' + baseY);
        points.push(finalTime + ':' + gapX + ':' + baseY);

        var result = {
          sliderId: data.id,
          sliderX: gapX,
          sliderTrack: points.join(';')
        };
        console.log('[CaptchaSolver] solved, id=' + data.id + ' x=' + gapX + ' steps=' + points.length);
        return result;
      } catch (e) {
        console.log('[CaptchaSolver] error: ' + e.message);
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
    await page.waitForTimeout(3000);
    await saveScreenshot(page, '01_initial.png');

    await injectSolver(page);
    console.log('🔧 滑块求解器已注入');

    console.log('🔐 登录中...');
    await page.locator('#renewKey').fill(CHECKIN_KEY);
    await page.waitForTimeout(500);
    await saveScreenshot(page, '02_after_input.png');

    await page.locator('#renewLogin button.ci-btn.renew').click({ timeout: 5000 });

    try {
      await page.locator('#renewCheckin').waitFor({ state: 'visible', timeout: 20000 });
      console.log('✅ 登录成功');
    } catch (e) {
      var loginError = await page.locator('#renewResult').textContent().catch(function() { return ''; });
      console.error('登录超时或失败: ' + loginError);
      await saveScreenshot(page, '03_login_failed.png');
      return false;
    }

    await page.waitForTimeout(3000);
    await saveScreenshot(page, '03_after_login.png');

    var checkinBtn = page.locator('#checkinBtn');
    var btnText = await checkinBtn.textContent().catch(function() { return ''; });
    var btnDisabled = await checkinBtn.isDisabled().catch(function() { return true; });
    console.log('签到按钮: "' + btnText + '" disabled=' + btnDisabled);

    if (btnText.indexOf('今日已签到') !== -1 || btnDisabled) {
      console.log('✅ 今日已签到');
      await saveScreenshot(page, '04_already_checked.png');
      return true;
    }

    var bindSection = page.locator('#renewEmailBind');
    var bindVisible = await bindSection.isVisible().catch(function() { return false; });
    var boundCaptchaSection = page.locator('#renewBoundCaptcha');
    var boundCaptchaVisible = await boundCaptchaSection.isVisible().catch(function() { return false; });

    if (bindVisible) {
      var checkinEmail = process.env.CHECKIN_EMAIL;
      var emailCode = process.env.CHECKIN_EMAIL_CODE;
      if (checkinEmail && emailCode) {
        console.log('📧 检测到需要绑定邮箱，自动填写');
        await page.locator('#renewEmail').fill(checkinEmail);
        await page.locator('#renewSendCodeBtn').click();
        console.log('等待验证码发送...');
        await page.waitForTimeout(3000);
        await page.locator('#renewEmailCode').fill(emailCode);
        await page.waitForTimeout(500);
      } else {
        console.log('⚠️ 需要绑定邮箱，但未提供 CHECKIN_EMAIL/CHECKIN_EMAIL_CODE 环境变量');
        console.log('尝试直接点击签到按钮（可能触发验证码流程）...');
      }
    } else if (boundCaptchaVisible) {
      console.log('🔐 检测到已绑定邮箱，等待验证码准备...');
      await page.waitForTimeout(2000);
    }

    console.log('📝 开始签到...');
    await checkinBtn.click({ timeout: 5000 });

    await page.waitForTimeout(2000);

    try {
      await page.waitForFunction(function() {
        var btn = document.getElementById('checkinBtn');
        if (!btn) return true;
        var text = btn.textContent || '';
        return text.indexOf('今日已签到') !== -1 || btn.disabled;
      }, { timeout: 35000 });
      console.log('签到按钮状态已更新');
    } catch (e) {
      var btnStatus = await page.locator('#checkinBtn').textContent().catch(function() { return ''; });
      console.log('签到按钮状态未变化: "' + btnStatus + '"');
    }

    await page.waitForTimeout(2000);
    await saveScreenshot(page, '04_after_checkin.png');

    var finalBtnText = await page.locator('#checkinBtn').textContent().catch(function() { return ''; });
    var finalDisabled = await page.locator('#checkinBtn').isDisabled().catch(function() { return true; });
    console.log('最终按钮: "' + finalBtnText + '" disabled=' + finalDisabled);

    if (finalBtnText.indexOf('今日已签到') !== -1 || finalDisabled) {
      console.log('✅ 签到成功');
      return true;
    }

    var resultText = await page.locator('#renewResult').textContent().catch(function() { return ''; });
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