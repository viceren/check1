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
const MAX_CAPTCHA_RETRIES = 5;

// ===== 日志同时落盘 checkin.log（便于 GitHub Actions 产物排查）=====
const LOG_FILE = process.env.LOG_FILE || 'checkin.log';
try { fs.mkdirSync(path.dirname(LOG_FILE) || '.', { recursive: true }); } catch (e) {}
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
function _fmt(args) {
  // arguments 是类数组对象，没有 .map，必须先转成真数组
  var arr = Array.prototype.slice.call(args);
  return arr.map(function (a) { return typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a)); }).join(' ');
}
console.log = function () { var m = _fmt(arguments); try { _logStream.write(m + '\n'); } catch (e) {} _origLog(m); };
console.error = function () { var m = _fmt(arguments); try { _logStream.write(m + '\n'); } catch (e) {} _origErr(m); };

async function saveScreenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
    console.log('📸 截图: ' + name);
  } catch (e) {}
}

// ===== 模板匹配求解缺口（piece 与 bg 比对，最吻合处即真实缺口）=====
// 验证码的 piece 是从 bg 某处裁下的拼图块，把它在 bg 上滑动，
// 累加不透明像素与 bg 的差异，差异最小的位置就是缺口左边缘 = sliderX。
async function findGapByTemplateMatch(bgBase64, pieceBase64, pieceSize, y, width) {
  var bgBuf = Buffer.from(bgBase64, 'base64');
  var pcBuf = Buffer.from(pieceBase64, 'base64');

  var bgMeta = await sharp(bgBuf).metadata();
  var bgW = bgMeta.width, bgH = bgMeta.height;
  var bgRGBA = await sharp(bgBuf).ensureAlpha().raw().toBuffer();

  var pcMeta = await sharp(pcBuf).metadata();
  var pcW = pcMeta.width, pcH = pcMeta.height;
  var pcRGBA = await sharp(pcBuf).ensureAlpha().raw().toBuffer();

  var ps = pieceSize || pcW;
  var maxX = Math.max(0, (width || bgW) - ps);
  var best = { x: Math.round((width || bgW) * 0.3), score: Infinity };
  var allScores = [];

  for (var x = 0; x <= maxX; x++) {
    var diff = 0, opaque = 0;
    for (var py = 0; py < pcH; py++) {
      var by = (y || 0) + py;
      if (by < 0 || by >= bgH) continue;
      for (var px = 0; px < pcW; px++) {
        var pIdx = (py * pcW + px) * 4;
        if (pcRGBA[pIdx + 3] < 20) continue; // 透明像素跳过
        var bx = x + px;
        if (bx < 0 || bx >= bgW) continue;
        var bIdx = (by * bgW + bx) * 4;
        diff += Math.abs(pcRGBA[pIdx] - bgRGBA[bIdx])
              + Math.abs(pcRGBA[pIdx + 1] - bgRGBA[bIdx + 1])
              + Math.abs(pcRGBA[pIdx + 2] - bgRGBA[bIdx + 2]);
        opaque++;
      }
    }
    var score = opaque > 0 ? diff / opaque : Infinity;
    allScores.push(score);
    if (score < best.score) best = { x: x, score: score };
  }

  // 置信度检查：最优分数应明显低于中位数，否则说明 bg 不含缺口信息，改用边缘检测兜底
  allScores.sort(function (a, b) { return a - b; });
  var median = allScores[Math.floor(allScores.length / 2)] || 1;
  var ratio = best.score / median;
  console.log('[GapSolver] 模板匹配最优 x=' + best.x + ' score=' + best.score.toFixed(1) + ' median=' + median.toFixed(1) + ' ratio=' + ratio.toFixed(2));
  if (ratio > 0.92) {
    console.log('[GapSolver] ⚠ 模板匹配置信度低（bg 可能不含缺口），回退边缘检测');
    return null;
  }
  return best.x;
}

// ===== 亮度法求解缺口（最可靠）：在 y 带 [y, y+pieceSize] 内找最亮连续区，左边缘 = sliderX =====
// 该 captcha 的缺口是 bg 上的亮色矩形补丁，列均值在缺口处显著高于背景基线。
async function findGapByBrightness(bgBase64, pieceSize, gapY, width) {
  var buf = Buffer.from(bgBase64, 'base64');
  var meta = await sharp(buf).metadata();
  var w = meta.width, h = meta.height;
  if (!w || !h) return null;
  var raw = await sharp(buf).raw().toBuffer(); // RGB
  var ps = pieceSize || 52;
  var y0 = Math.max(0, gapY || 0);
  var y1 = Math.min(h, y0 + ps);
  if (y1 <= y0) return null;

  // 每列在 y 带内的平均灰度
  var colMean = new Float64Array(w);
  for (var x = 0; x < w; x++) {
    var s = 0, n = 0;
    for (var row = y0; row < y1; row++) {
      var i = (row * w + x) * 3;
      s += (raw[i] + raw[i + 1] + raw[i + 2]) / 3;
      n++;
    }
    colMean[x] = n > 0 ? s / n : 0;
  }
  // 基线（中位数）与最亮列
  var sorted = Array.from(colMean).sort(function (a, b) { return a - b; });
  var median = sorted[Math.floor(sorted.length / 2)] || 0;
  var peak = -Infinity, peakX = 0;
  for (var x = 0; x < w; x++) {
    if (colMean[x] > peak) { peak = colMean[x]; peakX = x; }
  }
  var range = peak - median;
  if (range < 20) {
    console.log('[GapSolver] 亮度法置信度低 (range=' + range.toFixed(1) + '), 回退');
    return null;
  }
  // 从 peakX 向左找连续亮区左边缘（threshold = median + 0.3*range）
  var th = median + range * 0.3;
  var leftEdge = peakX;
  for (var x = peakX; x >= 0; x--) {
    if (colMean[x] < th) { leftEdge = x + 1; break; }
    leftEdge = x;
  }
  // 约束：缺口不能超出最大可拖动范围
  var maxX = Math.max(0, (width || w) - ps);
  if (leftEdge > maxX) leftEdge = maxX;
  if (leftEdge < 0) leftEdge = 0;
  console.log('[GapSolver] 亮度法 peakX=' + peakX + ' peak=' + peak.toFixed(1) + ' median=' + median.toFixed(1) + ' leftEdge=' + leftEdge + ' maxX=' + maxX);
  return leftEdge;
}

// ===== Node.js 端 gap 检测（边缘检测兜底，仅在无 piece 时使用）=====
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

// ===== 判断错误是否可重试：验证码失败、网络错误、429限流等均视为可重试 =====
function classifyError(resultText) {
  var t = resultText || '';
  // 验证码类错误
  var captchaErr = t.indexOf('人机验证') !== -1 || t.indexOf('human') !== -1 ||
                   t.indexOf('请完成') !== -1 || t.indexOf('Complete') !== -1 ||
                   t.indexOf('验证') !== -1 || t.indexOf('verif') !== -1;
  // 网络类错误：网络错误、超时、429限流、请求频繁等
  var netErr = t.indexOf('网络错误') !== -1 || t.indexOf('网络') !== -1 ||
               t.indexOf('network') !== -1 || t.toLowerCase().indexOf('timeout') !== -1 ||
               t.indexOf('超时') !== -1 ||
               t.indexOf('429') !== -1 || t.indexOf('Too Many Requests') !== -1 ||
               t.indexOf('请求频繁') !== -1 || t.indexOf('频繁') !== -1;
  return { retryable: captchaErr || netErr, type: netErr ? 'network' : 'captcha' };
}

// ===== 指数退避延迟：base * 2^(attempt-1) + 随机抖动，封顶 maxMs =====
function backoffDelay(attempt, baseMs, maxMs) {
  baseMs = baseMs || 2000;
  maxMs = maxMs || 30000;
  var delay = baseMs * Math.pow(2, attempt - 1);
  delay += Math.floor(Math.random() * 1000); // 抖动，避免固定节奏触发风控
  return Math.min(delay, maxMs);
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
        '--disable-extensions'
        // 注意：不再使用 --single-process / --no-zygote，
        // 这两个参数在较新 Chromium 上极易导致渲染进程崩溃（GitHub Action 中尤为常见）
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

        // 优先用模板匹配（piece 与 bg 比对），更可靠；无 piece 时回退边缘检测
        // 优先用亮度法：在该 captcha 上最准（缺口是 bg 上的亮色矩形补丁，找最亮连续区左边缘）
        var gapX = await findGapByBrightness(captchaData.bgBase64, pieceSize, gapY, captchaData.width);
        if (gapX === null || gapX === undefined) {
          // 回退：模板匹配（piece 与 bg 比对）
          if (captchaData.pieceBase64) {
            gapX = await findGapByTemplateMatch(captchaData.bgBase64, captchaData.pieceBase64, pieceSize, gapY, captchaData.width);
          }
          if (gapX === null || gapX === undefined) {
            gapX = await findGapFromBase64(captchaData.bgBase64, pieceSize, gapY);
          }
        }
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
    await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#renewKey', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(2000);
    await saveScreenshot(page, '01_initial.png');

    // ===== 覆盖 runSliderCaptcha =====
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

          // 2) 获取背景图 + 拼图块 base64 数据
          var bgValue = data.bg;
          var base64 = null;
          if (bgValue && bgValue.startsWith('data:')) {
            var commaIdx = bgValue.indexOf(',');
            if (commaIdx !== -1) base64 = bgValue.substring(commaIdx + 1) || null;
            console.log('[CaptchaSolver] bg 是 data URI, base64长度=' + (base64 ? base64.length : 0));
          } else {
            var bgUrl = bgValue || '';
            if (!bgUrl.startsWith('http')) {
              bgUrl = window.location.origin + (bgUrl.startsWith('/') ? '' : '/') + bgUrl;
            }
            var imgR = await fetch(bgUrl, { cache: 'no-store' });
            if (!imgR.ok) { console.log('[CaptchaSolver] 背景图下载失败: ' + imgR.status); return null; }
            var blob = await imgR.blob();
            base64 = await new Promise(function(resolve) {
              var reader = new FileReader();
              reader.onloadend = function() { resolve(reader.result.split(',')[1] || null); };
              reader.onerror = function() { resolve(null); };
              reader.readAsDataURL(blob);
            });
            console.log('[CaptchaSolver] 背景图 fetch 成功, base64长度=' + (base64 ? base64.length : 0));
          }

          // 拼图块（模板匹配需要）
          var pieceBase64 = null;
          if (data.piece && data.piece.startsWith('data:')) {
            var pIdx = data.piece.indexOf(',');
            if (pIdx !== -1) pieceBase64 = data.piece.substring(pIdx + 1) || null;
          }

          if (!base64) {
            console.log('[CaptchaSolver] 背景图转 base64 失败');
            return null;
          }

          // 3) 调用 Node.js 暴露的求解函数
          var result = await window.__solveCaptcha({
            id: data.id,
            bgBase64: base64,
            pieceBase64: pieceBase64,
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
    console.log('🔧 滑块求解器已注入（模板匹配模式）');

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

      var errInfo = classifyError(resultText);

      if (errInfo.retryable && attempt < MAX_CAPTCHA_RETRIES) {
        var delay = backoffDelay(attempt, 2000, 30000);
        console.log('❌ ' + (errInfo.type === 'network' ? '网络错误/限流' : '验证码失败') + '，' + (delay / 1000).toFixed(1) + 's 后重试...');
        await page.waitForTimeout(delay);
      } else if (errInfo.retryable) {
        console.log('❌ ' + (errInfo.type === 'network' ? '网络错误' : '验证码求解失败') + '，已达最大重试次数');
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
    try { _logStream.end(); } catch (e) {}
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
