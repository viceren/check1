require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CHECKIN_KEY = process.env.CHECKIN_KEY;
if (!CHECKIN_KEY) {
  console.error('未设置CHECKIN_KEY环境变量');
  process.exit(1);
}

const CHECKIN_URL = 'https://gpt.qt.cool/checkin';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || 'artifacts';
const MAX_CAPTCHA_RETRIES = 3;

async function saveScreenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
    console.log('📸 截图: ' + name);
  } catch (e) {}
}

// ===== Node.js 端 gap 检测（接收 base64 图片数据）=====
async function findGapFromBase64(bgBase64, pieceSize, gapY) {
  var imgBuffer = Buffer.from(bgBase64, 'base64');
  console.log('[GapSolver] 图片大小: ' + imgBuffer.length + ' bytes');

  var meta = await sharp(imgBuffer).metadata();
  var imgWidth = meta.width;
  var imgHeight = meta.height;
  console.log('[GapSolver] 尺寸: ' + imgWidth + 'x' + imgHeight);

  if (!imgWidth || !imgHeight || meta.format === undefined) {
    throw new Error('图片格式无效: ' + JSON.stringify(meta));
  }

  // 提取灰度像素数据
  var rawData = await sharp(imgBuffer).grayscale().raw().toBuffer();
  var h = imgHeight;

  // 确定扫描行范围
  var startRow = Math.max(0, (gapY || 0) - 8);
  var endRow = Math.min(h, (gapY || 0) + pieceSize + 8);
  if (endRow - startRow < 16) { startRow = 0; endRow = h; }
  var scanHeight = endRow - startRow;

  // Sobel 边缘检测
  var edges = new Float64Array(imgWidth);
  for (var x = 0; x < imgWidth; x++) {
    var sum = 0;
    for (var row = startRow; row < endRow; row++) {
      for (var c = -1; c <= 1; c++) {
        var px = Math.min(Math.max(x + c, 0), imgWidth - 1);
        var idx = row * imgWidth + px;
        var gray = rawData[idx];
        var weight = c === 0 ? 0 : (c < 0 ? -1 : 1);
        sum += gray * weight;
      }
    }
    edges[x] = Math.abs(sum) / (scanHeight * 2);
  }

  // 5点平滑
  var smoothed = new Float64Array(imgWidth);
  for (var x = 2; x < imgWidth - 2; x++) {
    smoothed[x] = (edges[x - 2] + edges[x - 1] * 2 + edges[x] * 3 + edges[x + 1] * 2 + edges[x + 2]) / 9;
  }
  for (var x = 2; x < imgWidth - 2; x++) edges[x] = smoothed[x];

  // 自适应阈值
  var threshold = 0, count = 0;
  for (var x = 0; x < imgWidth; x++) {
    if (edges[x] > threshold) { threshold += edges[x]; count++; }
  }
  threshold = count > 0 ? (threshold / count) * 0.55 : 0;

  // 找峰值
  var peaks = [];
  for (var x = 2; x < imgWidth - 2; x++) {
    if (edges[x] > threshold && edges[x] > edges[x - 1] && edges[x] > edges[x + 1]
      && edges[x] >= edges[x - 2] && edges[x] >= edges[x + 2]) {
      peaks.push({ x: x, value: edges[x] });
    }
  }
  peaks.sort(function(a, b) { return b.value - a.value; });

  console.log('[GapSolver] width=' + imgWidth + ' pieceSize=' + pieceSize + ' peaks=' + peaks.length + ' threshold=' + threshold.toFixed(1));
  for (var i = 0; i < Math.min(peaks.length, 8); i++) {
    console.log('[GapSolver]   peak[' + i + ']: x=' + peaks[i].x + ' val=' + peaks[i].value.toFixed(2));
  }

  // 方法1：找间距等于 pieceSize 的峰值对
  var LIMIT = Math.min(peaks.length, 15);
  for (var i = 0; i < LIMIT; i++) {
    for (var j = i + 1; j < LIMIT; j++) {
      var dist = Math.abs(peaks[i].x - peaks[j].x);
      if (Math.abs(dist - pieceSize) <= 8) {
        var left = Math.min(peaks[i].x, peaks[j].x);
        console.log('[GapSolver] ✓ gap pair: left=' + left + ' right=' + Math.max(peaks[i].x, peaks[j].x) + ' dist=' + dist);
        return left;
      }
    }
  }

  // 方法2：top2 间距接近 pieceSize
  if (peaks.length > 1) {
    var d1 = Math.abs(peaks[0].x - peaks[1].x);
    if (Math.abs(d1 - pieceSize) <= 12) {
      var left = Math.min(peaks[0].x, peaks[1].x);
      console.log('[GapSolver] ✓ gap top2: left=' + left + ' dist=' + d1);
      return left;
    }
  }

  // 方法3：最高峰
  if (peaks.length > 0) {
    console.log('[GapSolver] ⚠ fallback top peak: x=' + peaks[0].x);
    return peaks[0].x;
  }

  console.log('[GapSolver] ⚠ no peaks, using 0.3*width');
  return Math.round(imgWidth * 0.3);
}

// ===== 生成更真实的滑动轨迹 =====
function generateSliderTrack(gapX, baseY) {
  var totalTime = 600 + Math.floor(Math.random() * 400);
  var steps = 25 + Math.floor(Math.random() * 15);
  var points = [];

  for (var i = 0; i <= steps; i++) {
    var progress = i / steps;
    var eased = 1 - Math.pow(1 - progress, 3);
    eased = eased + (Math.random() - 0.5) * 0.015;
    eased = Math.min(1, Math.max(0, eased));

    var x = Math.round(eased * gapX);
    var t = Math.round(progress * totalTime);
    var y = Math.round(baseY + Math.sin(progress * Math.PI * 2) * 2 + (Math.random() - 0.5) * 5);
    points.push(t + ':' + x + ':' + y);
  }

  // 过冲 + 回弹
  var lastTime = totalTime;
  lastTime += 35 + Math.floor(Math.random() * 30);
  points.push(lastTime + ':' + (gapX + 2 + Math.floor(Math.random() * 3)) + ':' + Math.round(baseY + (Math.random() - 0.5) * 2));
  lastTime += 30 + Math.floor(Math.random() * 30);
  points.push(lastTime + ':' + gapX + ':' + baseY);

  return points.join(';');
}

// ===== 主签到逻辑 =====
async function autoCheckin() {
  let browser = null;

  try {
    console.log('🚀 自动签到启动');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // 监听 console
    page.on('console', function(msg) {
      var t = msg.text();
      if (t.indexOf('[CaptchaSolver]') !== -1 || t.indexOf('[GapSolver]') !== -1) {
        console.log('  ' + t);
      }
    });

    // ===== 核心：暴露 Node.js 函数给浏览器 =====
    // 浏览器端调用 window.__solveCaptcha(captchaData) 时，
    // 实际执行 Node.js 端的函数（图片处理、gap 计算、轨迹生成）
    await page.exposeFunction('__solveCaptcha', async function(captchaData) {
      try {
        if (!captchaData || !captchaData.bgBase64) {
          console.log('[CaptchaSolver] 未收到图片数据');
          return null;
        }

        var pieceSize = captchaData.pieceSize || 52;
        var gapY = captchaData.y || 0;
        var id = captchaData.id;

        console.log('[CaptchaSolver] 收到求解请求: id=' + id + ' pieceSize=' + pieceSize + ' y=' + gapY);

        var gapX = await findGapFromBase64(captchaData.bgBase64, pieceSize, gapY);
        console.log('[CaptchaSolver] 计算得到 gapX=' + gapX);

        var track = generateSliderTrack(gapX, gapY);
        var result = {
          sliderId: id,
          sliderX: gapX,
          sliderTrack: track
        };

        console.log('[CaptchaSolver] 求解完成: sliderId=' + result.sliderId + ' sliderX=' + result.sliderX + ' points=' + track.split(';').length);
        return result;
      } catch (e) {
        console.log('[CaptchaSolver] 求解异常: ' + e.message);
        return null;
      }
    });

    console.log('访问: ' + CHECKIN_URL);
    await page.goto(CHECKIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, '01_initial.png');

    // ===== 覆盖 runSliderCaptcha =====
    // 浏览器内：fetch 验证码数据 + fetch 背景图转 base64 → 调用 Node.js 暴露的 __solveCaptcha
    await page.evaluate(function() {
      window._originalRunSliderCaptcha = window.runSliderCaptcha;
      window.runSliderCaptcha = async function(opts) {
        opts = opts || {};
        console.log('[CaptchaSolver] runSliderCaptcha called');

        try {
          // 1) 获取验证码配置
          var r = await fetch('/auth/captcha?mode=slider', { cache: 'no-store' });
          var d = await r.json();
          if (d.code !== 0 || !d.data || !d.data.slider) {
            var r2 = await fetch('/auth/captcha?mode=slider&t=' + Date.now(), { cache: 'no-store' });
            var d2 = await r2.json();
            if (d2.code !== 0 || !d2.data || !d2.data.slider) {
              console.log('[CaptchaSolver] 验证码不可用');
              return null;
            }
            d = d2;
          }
          var data = d.data;

          // 2) 获取背景图 base64 数据
          //    服务器可能返回 data: URI（内联 base64）或 URL 路径
          var bgValue = data.bg;
          var base64 = null;

          if (bgValue && bgValue.startsWith('data:')) {
            // 直接从 data URI 中提取 base64 部分
            var commaIdx = bgValue.indexOf(',');
            if (commaIdx !== -1) {
              base64 = bgValue.substring(commaIdx + 1) || null;
            }
            console.log('[CaptchaSolver] bg 是 data URI, base64长度=' + (base64 ? base64.length : 0));
          } else {
            // 旧模式：bg 是 URL 路径，需要 fetch 下载
            var bgUrl = bgValue || '';
            if (!bgUrl.startsWith('http')) {
              bgUrl = window.location.origin + (bgUrl.startsWith('/') ? '' : '/') + bgUrl;
            }
            var imgR = await fetch(bgUrl, { cache: 'no-store' });
            if (!imgR.ok) {
              console.log('[CaptchaSolver] 背景图下载失败: ' + imgR.status);
              return null;
            }
            var blob = await imgR.blob();
            base64 = await new Promise(function(resolve) {
              var reader = new FileReader();
              reader.onloadend = function() { resolve(reader.result.split(',')[1] || null); };
              reader.onerror = function() { resolve(null); };
              reader.readAsDataURL(blob);
            });
            console.log('[CaptchaSolver] 背景图 fetch 成功, base64长度=' + (base64 ? base64.length : 0));
          }

          if (!base64) {
            console.log('[CaptchaSolver] 背景图转 base64 失败');
            return null;
          }

          // 3) 调用 Node.js 暴露的求解函数
          var result = await window.__solveCaptcha({
            id: data.id,
            bgBase64: base64,
            width: data.width,
            pieceSize: data.pieceSize || 52,
            y: data.y || 0
          });

          console.log('[CaptchaSolver] got solution: ' + JSON.stringify(result));
          return result;
        } catch (e) {
          console.log('[CaptchaSolver] error: ' + e.message);
          return null;
        }
      };
    });
    console.log('🔧 滑块求解器已注入（exposeFunction 模式）');

    // 登录
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

    await page.waitForTimeout(2000);
    await saveScreenshot(page, '03_after_login.png');

    // 检查签到按钮
    var checkinBtn = page.locator('#checkinBtn');
    var btnText = await checkinBtn.textContent().catch(function() { return ''; });
    var btnDisabled = await checkinBtn.isDisabled().catch(function() { return true; });
    console.log('签到按钮: "' + btnText + '" disabled=' + btnDisabled);

    if (btnText.indexOf('今日已签到') !== -1 || btnText.indexOf('Already') !== -1 || btnDisabled) {
      console.log('✅ 今日已签到');
      await saveScreenshot(page, '04_already_checked.png');
      return true;
    }

    // 检查绑定邮箱
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
        await page.waitForTimeout(5000);
        await page.locator('#renewEmailCode').fill(emailCode);
        await page.waitForTimeout(500);
      } else {
        console.log('⚠️ 需要绑定邮箱，但未提供 CHECKIN_EMAIL/CHECKIN_EMAIL_CODE 环境变量');
      }
    } else if (boundCaptchaVisible) {
      console.log('🔐 检测到已绑定邮箱，签到需要滑块验证');
    }

    // 签到 + 重试
    var success = false;
    for (var attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
      console.log('📝 签到尝试 ' + attempt + '/' + MAX_CAPTCHA_RETRIES);
      await checkinBtn.click({ timeout: 5000 });
      await page.waitForTimeout(4000);
      await saveScreenshot(page, '04_after_checkin_attempt' + attempt + '.png');

      var finalBtnText = await page.locator('#checkinBtn').textContent().catch(function() { return ''; });
      var finalDisabled = await page.locator('#checkinBtn').isDisabled().catch(function() { return true; });
      console.log('按钮状态: "' + finalBtnText + '" disabled=' + finalDisabled);

      if (finalBtnText.indexOf('今日已签到') !== -1 || finalBtnText.indexOf('Already') !== -1 || finalDisabled) {
        console.log('✅ 签到成功');
        success = true;
        break;
      }

      var resultText = await page.locator('#renewResult').textContent().catch(function() { return ''; });
      console.log('结果消息: ' + resultText);

      if (resultText.indexOf('成功') !== -1 || resultText.indexOf('success') !== -1 ||
          resultText.indexOf('已签到') !== -1 || resultText.indexOf('Already') !== -1) {
        console.log('✅ 签到成功');
        success = true;
        break;
      }

      var needRetry = resultText.indexOf('人机验证') !== -1 || resultText.indexOf('human') !== -1 ||
                      resultText.indexOf('请完成') !== -1 || resultText.indexOf('Complete') !== -1 ||
                      resultText.indexOf('验证') !== -1 || resultText.indexOf('verif') !== -1;

      if (needRetry && attempt < MAX_CAPTCHA_RETRIES) {
        console.log('❌ 验证码失败，将重试...');
        await page.waitForTimeout(1000);
      } else if (needRetry) {
        console.log('❌ 验证码求解失败，已达最大重试次数');
      } else {
        console.log('❌ 其他错误，停止重试');
        break;
      }
    }

    await saveScreenshot(page, '05_final.png');
    return success;

  } catch (error) {
    console.error('错误: ' + error.message);
    console.error('错误堆栈: ' + (error.stack || ''));
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
