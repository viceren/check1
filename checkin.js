require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
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

// ===== Node.js 端图片处理 =====
function downloadImage(url) {
  return new Promise(function(resolve, reject) {
    var client = url.startsWith('https') ? https : http;
    client.get(url, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function findGapInNode(bgImageUrl, width, pieceSize, gapY) {
  console.log('[GapSolver] 下载背景图: ' + bgImageUrl);
  var imgBuffer = await downloadImage(bgImageUrl);
  console.log('[GapSolver] 图片大小: ' + imgBuffer.length + ' bytes');

  var meta = await sharp(imgBuffer).metadata();
  var imgWidth = meta.width;
  var imgHeight = meta.height;
  console.log('[GapSolver] 原始尺寸: ' + imgWidth + 'x' + imgHeight);

  // 提取原始尺寸的灰度像素数据
  var rawData = await sharp(imgBuffer)
    .grayscale()
    .raw()
    .toBuffer();

  var h = imgHeight;

  // 确定扫描行范围（优先在 gap 区域扫描）
  var startRow = Math.max(0, (gapY || 0) - 8);
  var endRow = Math.min(h, (gapY || 0) + pieceSize + 8);
  if (endRow - startRow < 16) { startRow = 0; endRow = h; }
  var scanHeight = endRow - startRow;

  // 用原始像素宽度计算边缘
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

  // 平滑
  var smoothed = new Float64Array(imgWidth);
  for (var x = 2; x < imgWidth - 2; x++) {
    smoothed[x] = (edges[x - 2] + edges[x - 1] * 2 + edges[x] * 3 + edges[x + 1] * 2 + edges[x + 2]) / 9;
  }
  for (var x = 2; x < imgWidth - 2; x++) {
    edges[x] = smoothed[x];
  }

  // 自适应阈值
  var threshold = 0;
  var count = 0;
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

  // 打印 top peaks
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
        console.log('[GapSolver] ✓ gap pair detected: left=' + left + ' right=' + Math.max(peaks[i].x, peaks[j].x) + ' dist=' + dist);
        return left;
      }
    }
  }

  // 方法2：top2 峰值间距接近 pieceSize
  if (peaks.length > 1) {
    var d1 = Math.abs(peaks[0].x - peaks[1].x);
    if (Math.abs(d1 - pieceSize) <= 12) {
      var left = Math.min(peaks[0].x, peaks[1].x);
      console.log('[GapSolver] ✓ gap top2: left=' + left + ' dist=' + d1);
      return left;
    }
  }

  // 方法3：直接用最高峰
  if (peaks.length > 0) {
    console.log('[GapSolver] ⚠ fallback to top peak: x=' + peaks[0].x);
    return peaks[0].x;
  }

  console.log('[GapSolver] ⚠ no peaks found, using 0.3*width');
  return Math.round(imgWidth * 0.3);
}

// ===== 生成更真实的滑动轨迹 =====
function generateSliderTrack(gapX, baseY) {
  var totalTime = 500 + Math.floor(Math.random() * 500);
  var steps = 25 + Math.floor(Math.random() * 20);
  var points = [];

  // 使用贝塞尔曲线模拟人类滑动
  // 起始慢 → 中间加速 → 末端减速并微调
  for (var i = 0; i <= steps; i++) {
    var progress = i / steps;
    // ease-out-cubic 变体，加入微小随机抖动
    var eased = 1 - Math.pow(1 - progress, 3);
    eased = eased + (Math.random() - 0.5) * 0.02; // 微小抖动
    eased = Math.min(1, Math.max(0, eased));

    var x = Math.round(eased * gapX);
    var t = Math.round(progress * totalTime);
    // y 轴有轻微上下浮动，模拟手颤
    var y = Math.round(baseY + Math.sin(progress * Math.PI * 2) * 3 + (Math.random() - 0.5) * 6);
    points.push(t + ':' + x + ':' + y);
  }

  // 末端过冲+回弹，人类滑动特征
  var overshotSteps = 2 + Math.floor(Math.random() * 3);
  var lastTime = totalTime;
  var lastX = Math.round(gapX);

  for (var k = 1; k <= overshotSteps; k++) {
    lastTime += 30 + Math.floor(Math.random() * 40);
    if (k === 1) {
      // 过冲 2-5 像素
      lastX = gapX + 2 + Math.floor(Math.random() * 4);
    } else {
      // 回弹到正确位置
      lastX = gapX + Math.floor((Math.random() - 0.5) * 2);
    }
    points.push(lastTime + ':' + lastX + ':' + Math.round(baseY + (Math.random() - 0.5) * 3));
  }

  // 确保最后一个点最接近 gapX
  lastTime += 20 + Math.floor(Math.random() * 30);
  points.push(lastTime + ':' + gapX + ':' + baseY);

  return points.join(';');
}

// ===== 注入求解器到页面 =====
async function injectSolver(page, captchaResults) {
  await page.evaluate(function() {
    // 保存原始函数引用
    window._originalRunSliderCaptcha = window.runSliderCaptcha;

    // 覆盖为延迟版本：等待外部设置结果
    window._captchaResolve = null;
    window._captchaPromise = null;

    window.runSliderCaptcha = async function(opts) {
      opts = opts || {};
      console.log('[CaptchaSolver] runSliderCaptcha called, waiting for solution...');

      // 创建一个新的Promise等待外部求解
      window._captchaPromise = new Promise(function(resolve) {
        window._captchaResolve = resolve;
      });

      var result = await window._captchaPromise;
      console.log('[CaptchaSolver] got solution: ' + JSON.stringify(result));
      return result;
    };
  });
  console.log('🔧 滑块求解器已注入（等待模式）');
}

// ===== 在 Node 端求解验证码并通过 page.evaluate 传递给页面 =====
async function solveAndDeliverCaptcha(page) {
  // 等待页面开始请求验证码
  console.log('[CaptchaSolver] 等待页面调用 runSliderCaptcha...');

  // 轮询等待 _captchaPromise 被创建
  var maxWait = 30000;
  var startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    var hasPromise = await page.evaluate(function() {
      return window._captchaPromise !== null;
    });
    if (hasPromise) break;
    await page.waitForTimeout(200);
  }

  if (!(await page.evaluate(function() { return window._captchaPromise !== null; }))) {
    console.log('[CaptchaSolver] 超时：页面未调用 runSliderCaptcha');
    return false;
  }

  console.log('[CaptchaSolver] 页面已调用 runSliderCaptcha，开始求解...');

  // 在浏览器中获取验证码数据
  var captchaData = await page.evaluate(async function() {
    try {
      var r = await fetch('/auth/captcha?mode=slider', { cache: 'no-store' });
      var d = await r.json();
      if (d.code !== 0 || !d.data || !d.data.slider) {
        // 重试一次带时间戳
        var fr = await fetch('/auth/captcha?mode=slider&t=' + Date.now(), { cache: 'no-store' });
        var fd = await fr.json();
        if (fd.code !== 0 || !fd.data || !fd.data.slider) return null;
        return fd.data;
      }
      return d.data;
    } catch (e) {
      console.log('[CaptchaSolver] fetch captcha error: ' + e.message);
      return null;
    }
  });

  if (!captchaData) {
    console.log('[CaptchaSolver] 无法获取验证码数据');
    await page.evaluate(function() {
      if (window._captchaResolve) window._captchaResolve(null);
    });
    return false;
  }

  console.log('[CaptchaSolver] 验证码数据: id=' + captchaData.id + ' width=' + captchaData.width + ' pieceSize=' + (captchaData.pieceSize || 52) + ' y=' + (captchaData.y || 0));

  // 在 Node 端计算 gap
  var bgUrl = captchaData.bg;
  if (!bgUrl.startsWith('http')) {
    bgUrl = 'https://gpt.qt.cool' + (bgUrl.startsWith('/') ? '' : '/') + bgUrl;
  }

  var gapX;
  try {
    gapX = await findGapInNode(bgUrl, captchaData.width, captchaData.pieceSize || 52, captchaData.y || 0);
  } catch (e) {
    console.log('[CaptchaSolver] 图片处理失败: ' + e.message);
    await page.evaluate(function() {
      if (window._captchaResolve) window._captchaResolve(null);
    });
    return false;
  }

  console.log('[CaptchaSolver] 计算得到 gapX=' + gapX);

  // 生成轨迹
  var track = generateSliderTrack(gapX, captchaData.y || 0);
  var result = {
    sliderId: captchaData.id,
    sliderX: gapX,
    sliderTrack: track
  };

  console.log('[CaptchaSolver] 求解结果: sliderId=' + result.sliderId + ' sliderX=' + result.sliderX + ' trackPoints=' + track.split(';').length);

  // 传递结果给页面
  var delivered = await page.evaluate(function(res) {
    if (window._captchaResolve) {
      window._captchaResolve(res);
      return true;
    }
    return false;
  }, result);

  if (delivered) {
    console.log('[CaptchaSolver] ✅ 结果已传递给页面');
  } else {
    console.log('[CaptchaSolver] ❌ 无法传递结果给页面');
  }

  return delivered;
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

    // 监听所有 console 消息
    page.on('console', function(msg) {
      var t = msg.text();
      if (t.indexOf('[CaptchaSolver]') !== -1 || t.indexOf('[GapSolver]') !== -1) {
        console.log('  ' + t);
      }
    });

    console.log('访问: ' + CHECKIN_URL);
    await page.goto(CHECKIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, '01_initial.png');

    // 注入求解器
    await injectSolver(page);
    console.log('🔧 滑块求解器已注入');

    // 等待页面完全加载后登录
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

    // 检查签到按钮状态
    var checkinBtn = page.locator('#checkinBtn');
    var btnText = await checkinBtn.textContent().catch(function() { return ''; });
    var btnDisabled = await checkinBtn.isDisabled().catch(function() { return true; });
    console.log('签到按钮: "' + btnText + '" disabled=' + btnDisabled);

    if (btnText.indexOf('今日已签到') !== -1 || btnDisabled) {
      console.log('✅ 今日已签到');
      await saveScreenshot(page, '04_already_checked.png');
      return true;
    }

    // 检查是否需要绑定邮箱
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
        console.log('等待验证码发送过程中的滑块验证...');
        // 发送验证码也会触发滑块验证
        await solveAndDeliverCaptcha(page);
        await page.waitForTimeout(3000);
        await page.locator('#renewEmailCode').fill(emailCode);
        await page.waitForTimeout(500);
      } else {
        console.log('⚠️ 需要绑定邮箱，但未提供 CHECKIN_EMAIL/CHECKIN_EMAIL_CODE 环境变量');
      }
    } else if (boundCaptchaVisible) {
      console.log('🔐 检测到已绑定邮箱，签到需要滑块验证');
    }

    // 点击签到按钮后立即求解验证码
    console.log('📝 开始签到...');
    var clickPromise = checkinBtn.click({ timeout: 5000 });

    // 同时启动验证码求解
    var solvePromise = solveAndDeliverCaptcha(page);

    // 等待两者完成
    await Promise.all([clickPromise, solvePromise]);

    // 等待签到结果
    await page.waitForTimeout(3000);

    // 检查签到是否成功，如果失败则重试几次
    var success = false;
    for (var attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
      await saveScreenshot(page, '04_after_checkin_attempt' + attempt + '.png');

      var finalBtnText = await page.locator('#checkinBtn').textContent().catch(function() { return ''; });
      var finalDisabled = await page.locator('#checkinBtn').isDisabled().catch(function() { return true; });
      console.log('尝试 ' + attempt + ': 按钮="' + finalBtnText + '" disabled=' + finalDisabled);

      if (finalBtnText.indexOf('今日已签到') !== -1 || finalDisabled) {
        console.log('✅ 签到成功');
        success = true;
        break;
      }

      var resultText = await page.locator('#renewResult').textContent().catch(function() { return ''; });
      console.log('结果消息: ' + resultText);

      if (resultText.indexOf('成功') !== -1 || resultText.indexOf('已签到') !== -1) {
        console.log('✅ 签到成功');
        success = true;
        break;
      }

      if (resultText.indexOf('人机验证') !== -1 || resultText.indexOf('请完成') !== -1) {
        if (attempt < MAX_CAPTCHA_RETRIES) {
          console.log('❌ 验证码求解失败，重试 ' + (attempt + 1) + '/' + MAX_CAPTCHA_RETRIES);

          // 重置验证码 resolver
          await page.evaluate(function() {
            window._captchaPromise = null;
            window._captchaResolve = null;
          });

          // 再次点击签到按钮
          var retryClickPromise = checkinBtn.click({ timeout: 5000 }).catch(function(e) {
            console.log('重试点击失败: ' + e.message);
          });
          var retrySolvePromise = solveAndDeliverCaptcha(page);

          await Promise.all([retryClickPromise, retrySolvePromise]);
          await page.waitForTimeout(3000);
        } else {
          console.log('❌ 验证码求解失败，已达最大重试次数');
        }
      } else {
        // 既不是验证码问题也不是成功，可能是其他错误
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
