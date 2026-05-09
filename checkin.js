/**
 * 自动签到脚本 - Playwright 版本 (v2)
 * 针对 gpt.qt.cool/checkin 最新页面
 * 特性：支持滑动验证码、邮箱绑定检测
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHECKIN_KEY = process.env.CHECKIN_KEY;
if (!CHECKIN_KEY) {
  console.error('❌ 未设置CHECKIN_KEY环境变量');
  process.exit(1);
}

const CHECKIN_URL = 'https://gpt.qt.cool/checkin';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || 'artifacts';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function screenshot(page, name) {
  await ensureDir(SCREENSHOT_DIR);
  const p = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`📸 截图: ${p}`);
  return p;
}

async function getSliderCaptchaData(page) {
  try {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/auth/captcha?mode=slider', { cache: 'no-store' });
      return r.json();
    });
    return resp;
  } catch (e) {
    console.error('获取滑动验证码失败:', e.message);
    return null;
  }
}

async function runSliderCaptchaDialog(page) {
  const data = await getSliderCaptchaData(page);
  if (!data || data.code !== 0 || !data.data?.slider) {
    console.log('ℹ️ 无需滑动验证码或获取失败');
    return null;
  }

  const { id, bg, piece, width, height, y, pieceSize } = data.data;
  console.log(`🔐 滑动验证码: id=${id}, 尺寸=${width}x${height}`);

  const result = await page.evaluate(async ({ captchaId, bgSrc, pieceSrc, imgW, imgH, pieceSz, pieceY }) => {
    return new Promise((resolve) => {
      const OVERLAY = document.createElement('div');
      OVERLAY.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.62);backdrop-filter:blur(6px);padding:18px';
      const CARD = document.createElement('div');
      CARD.style.cssText = 'width:360px;max-width:calc(100vw - 28px);border-radius:18px;background:#111827;border:1px solid rgba(148,163,184,.18);box-shadow:0 24px 80px rgba(0,0,0,.45);padding:18px;color:#e5e7eb;font-family:inherit';
      const TITLE = document.createElement('div');
      TITLE.style.cssText = 'font-size:14px;font-weight:800;margin-bottom:6px';
      TITLE.textContent = '自动验证中...';
      const DESC = document.createElement('div');
      DESC.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:12px;line-height:1.6';
      DESC.textContent = '正在分析缺口位置...';
      const STAGE = document.createElement('div');
      STAGE.style.cssText = `position:relative;width:${imgW}px;height:${imgH}px;max-width:100%;margin:0 auto 14px;border-radius:12px;overflow:hidden;background:#0f172a`;
      const BG_IMG = document.createElement('img');
      BG_IMG.src = bgSrc;
      BG_IMG.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
      const PIECE_IMG = document.createElement('img');
      PIECE_IMG.src = pieceSrc;
      PIECE_IMG.style.cssText = `position:absolute;left:0;top:${pieceY}px;width:${pieceSz}px;height:${pieceSz}px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.42))`;
      STAGE.appendChild(BG_IMG);
      STAGE.appendChild(PIECE_IMG);

      const TRACK = document.createElement('div');
      TRACK.style.cssText = 'position:relative;height:42px;border-radius:999px;background:rgba(148,163,184,.16);border:1px solid rgba(148,163,184,.20);overflow:hidden';
      const FILL = document.createElement('div');
      FILL.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,rgba(45,212,191,.26),rgba(59,130,246,.26))';
      const TEXT = document.createElement('div');
      TEXT.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#94a3b8';
      TEXT.textContent = '自动滑动中...';
      const HANDLE = document.createElement('div');
      HANDLE.style.cssText = 'position:absolute;left:2px;top:2px;width:38px;height:38px;border-radius:999px;background:linear-gradient(135deg,#2dd4bf,#60a5fa);box-shadow:0 8px 24px rgba(45,212,191,.35);display:flex;align-items:center;justify-content:center;color:#06121f;font-weight:900;cursor:grab';
      HANDLE.textContent = '›';

      TRACK.appendChild(FILL);
      TRACK.appendChild(TEXT);
      TRACK.appendChild(HANDLE);
      CARD.appendChild(TITLE);
      CARD.appendChild(DESC);
      CARD.appendChild(STAGE);
      CARD.appendChild(TRACK);
      OVERLAY.appendChild(CARD);
      document.body.appendChild(OVERLAY);

      TITLE.textContent = '🔍 正在检测缺口...';
      let imgLoaded = 0;
      const checkReady = () => {
        if (++imgLoaded < 2) return;
        analyzeAndSlide();
      };
      BG_IMG.onload = checkReady;
      PIECE_IMG.onload = checkReady;
      if (BG_IMG.complete) BG_IMG.onload();
      if (PIECE_IMG.complete) PIECE_IMG.onload();

      async function analyzeAndSlide() {
        TITLE.textContent = '🎯 分析缺口位置...';
        const canvas = document.createElement('canvas');
        canvas.width = imgW;
        canvas.height = imgH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(BG_IMG, 0, 0);
        const bgData = ctx.getImageData(0, 0, imgW, imgH).data;

        const pc = document.createElement('canvas');
        pc.width = pieceSz;
        pc.height = pieceSz;
        const pctx = pc.getContext('2d');
        pctx.drawImage(PIECE_IMG, 0, 0);
        const pieceData = pctx.getImageData(0, 0, pieceSz, pieceSz).data;

        const targetX = findBestMatch(bgData, pieceData, imgW, imgH, pieceSz, pieceY);
        console.log('检测到缺口位置:', targetX);

        TITLE.textContent = '➡️ 正在滑动...';
        const maxX = imgW - pieceSz;
        const targetSlide = Math.min(targetX, maxX);
        const duration = 800 + Math.random() * 400;
        const steps = 60;
        let step = 0;
        let currentX = 0;
        let points = [];

        const easeOut = t => 1 - Math.pow(1 - t, 3);

        const animate = () => {
          return new Promise(res => {
            const tick = () => {
              step++;
              const progress = easeOut(step / steps);
              currentX = targetSlide * progress;
              PIECE_IMG.style.left = currentX + 'px';
              HANDLE.style.left = (2 + currentX) + 'px';
              FILL.style.width = (currentX + 22) + 'px';
              const t = Math.round((Date.now() - (Date.now() - duration * (step / steps))) * 1);
              points.push(`${t}:${Math.round(currentX)}:${Math.round(Math.random() * 50)}`);
              if (step < steps) {
                requestAnimationFrame(tick);
              } else {
                PIECE_IMG.style.left = targetSlide + 'px';
                HANDLE.style.left = (2 + targetSlide) + 'px';
                FILL.style.width = (targetSlide + 22) + 'px';
                TEXT.textContent = '✅ 验证完成';
                HANDLE.style.background = 'linear-gradient(135deg,#10b981,#059669)';
                setTimeout(() => {
                  OVERLAY.remove();
                  resolve({
                    sliderId: captchaId,
                    sliderX: Math.round(targetSlide),
                    sliderTrack: points.slice(-80).join(';')
                  });
                }, 500);
              }
            };
            requestAnimationFrame(tick);
          });
        };
        await animate();
      }

      function findBestMatch(bg, piece, bgW, bgH, pSz, pY) {
        const pColors = [];
        for (let i = 0; i < pSz * pSz; i++) {
          const px = piece[i * 4];
          const py = piece[i * 4 + 1];
          const pa = piece[i * 4 + 3];
          if (pa > 50) pColors.push([px, py, i % pSz, Math.floor(i / pSz)]);
        }
        if (pColors.length === 0) return Math.floor(bgW / 2);

        let bestX = 0, bestScore = Infinity;
        const sampleStep = 3;
        const searchRange = Math.floor(bgW * 0.7);

        for (let bx = 0; bx < searchRange; bx += sampleStep) {
          let score = 0;
          let count = 0;
          for (const [pr, pg, lx, ly] of pColors) {
            const bgX = bx + lx;
            const bgY = pY + ly;
            if (bgX >= 0 && bgX < bgW && bgY >= 0 && bgY < bgH) {
              const bi = (bgY * bgW + bgX) * 4;
              const bgr = bg[bi], bgg = bg[bi + 1];
              score += Math.abs(pr - bgr) + Math.abs(pg - bgg);
              count++;
            }
          }
          if (count > 0 && score < bestScore) {
            bestScore = score;
            bestX = bx;
          }
        }
        return Math.max(0, Math.min(bestX, bgW - pSz));
      }
    });
  }, {
    captchaId: id,
    bgSrc: bg,
    pieceSrc: piece,
    imgW: width,
    imgH: height,
    pieceSz: pieceSize,
    pieceY: y
  });

  return result;
}

async function doApiLogin(page, key) {
  try {
    const resp = await page.evaluate(async (k) => {
      const r = await fetch('/portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k })
      });
      return r.json();
    }, key);
    return resp;
  } catch (e) {
    console.error('登录请求失败:', e.message);
    return null;
  }
}

async function getCheckinStatus(page) {
  try {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/portal/checkin/status');
      return r.json();
    });
    return resp;
  } catch (e) {
    console.error('获取签到状态失败:', e.message);
    return null;
  }
}

async function doApiCheckin(page, extraBody = {}) {
  try {
    const resp = await page.evaluate(async (body) => {
      const r = await fetch('/portal/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return r.json();
    }, extraBody);
    return resp;
  } catch (e) {
    console.error('签到请求失败:', e.message);
    return null;
  }
}

async function sendEmailCode(page, email, type = 'renew') {
  const captcha = await runSliderCaptchaDialog(page);
  if (!captcha) {
    console.error('发送邮箱验证码需要滑动验证');
    return null;
  }
  try {
    const resp = await page.evaluate(async ({ em, tp, cap }) => {
      const r = await fetch('/api/checkin/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em, ...cap })
      });
      return r.json();
    }, { em: email, tp: type, cap: captcha });
    return resp;
  } catch (e) {
    console.error('发送邮箱验证码失败:', e.message);
    return null;
  }
}

async function autoCheckin() {
  let browser = null;

  try {
    console.log('🚀 开始自动签到 (v2 - 滑动验证码版本)');
    await ensureDir(SCREENSHOT_DIR);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error(`[页面错误] ${msg.text()}`);
      }
    });

    console.log(`🌐 访问: ${CHECKIN_URL}`);
    await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    await screenshot(page, '1_initial');

    const statusData = await getCheckinStatus(page);

    if (statusData && statusData.code === 0 && statusData.data) {
      const data = statusData.data;
      console.log(`📊 状态: 已登录=${!!data.maskedKey}, 今日已签到=${!!data.checkedInToday}`);

      if (data.checkedInToday) {
        console.log('✅ 今日已完成签到!');
        await screenshot(page, 'already_signed');
        return { success: true, alreadySigned: true };
      }

      await screenshot(page, '2_logged_in');

      if (!data.emailBound) {
        console.log('📧 需要绑定邮箱（首次签到）');
        await screenshot(page, '3_need_email_bind');
        console.log('⚠️ 首次签到需绑定邮箱，当前脚本不支持自动邮箱绑定');
        return { success: false, reason: 'need_email_bind' };
      }

      const captcha = await runSliderCaptchaDialog(page);
      if (!captcha) {
        console.error('❌ 获取滑动验证码失败');
        await screenshot(page, '4_captcha_failed');
        return { success: false, reason: 'captcha_failed' };
      }

      await screenshot(page, '4_after_captcha');
      console.log('✅ 滑动验证完成，准备提交签到...');

      const result = await doApiCheckin(page, captcha);
      await screenshot(page, '5_checkin_result');

      if (result && result.code === 0) {
        console.log(`🎉 签到成功: ${result.data?.message || 'OK'}`);
        return { success: true, data: result.data };
      } else {
        console.error(`❌ 签到失败: ${result?.message || '未知错误'}`);
        return { success: false, reason: result?.message || 'checkin_failed' };
      }

    } else {
      console.log('🔐 未登录，开始登录流程...');
      await screenshot(page, '2_not_logged_in');

      const loginResp = await doApiLogin(page, CHECKIN_KEY);

      if (!loginResp || loginResp.code !== 0) {
        console.error(`❌ 登录失败: ${loginResp?.message || '未知错误'}`);
        await screenshot(page, '3_login_failed');
        return { success: false, reason: loginResp?.message || 'login_failed' };
      }

      console.log('✅ 登录成功!');
      await screenshot(page, '3_login_success');
      await sleep(1000);

      const newStatus = await getCheckinStatus(page);
      if (newStatus && newStatus.code === 0 && newStatus.data) {
        const data = newStatus.data;

        if (data.checkedInToday) {
          console.log('✅ 登录后确认：今日已签到!');
          return { success: true, alreadySigned: true };
        }

        if (!data.emailBound) {
          console.log('📧 首次签到需绑定邮箱，脚本不支持自动绑定');
          return { success: false, reason: 'need_email_bind' };
        }

        const captcha = await runSliderCaptchaDialog(page);
        if (!captcha) {
          return { success: false, reason: 'captcha_failed' };
        }

        const result = await doApiCheckin(page, captcha);

        if (result && result.code === 0) {
          console.log(`🎉 签到成功: ${result.data?.message || 'OK'}`);
          return { success: true, data: result.data };
        } else {
          return { success: false, reason: result?.message || 'checkin_failed' };
        }
      }

      return { success: false, reason: 'unknown' };
    }

  } catch (error) {
    console.error(`❌ 执行错误: ${error.message}`);
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          await screenshot(pages[0], 'error');
        }
      } catch (_) {}
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log('🔒 浏览器已关闭');
    }
  }
}

(async () => {
  try {
    console.log('========== 🚀 签到开始 (v2) ==========');
    const result = await autoCheckin();

    if (result.success) {
      if (result.alreadySigned) {
        console.log('✅ 今日已完成签到');
      } else {
        console.log(`✅ 签到成功: ${result.data?.message || ''}`);
      }
      process.exit(0);
    } else {
      console.log(`❌ 签到失败: ${result.reason}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ 异常退出: ${error.message}`);
    process.exit(1);
  }
})();
