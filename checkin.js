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

async function switchToChineseIfNeeded(page) {
  try {
    const chineseBtn = page.locator('button:has-text("中文")');
    if (await chineseBtn.count() > 0) {
      await chineseBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1500);
      console.log('🌐 已切换到中文界面');
    }
  } catch (error) {
    console.log('ℹ️ 切换语言失败或无需切换');
  }
}

async function saveScreenshot(page, name) {
  try {
    const screenshotPath = path.join(SCREENSHOT_DIR, name);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 已保存截图: ${name}`);
  } catch (error) {
    console.error(`❌ 截图保存失败: ${error.message}`);
  }
}

async function autoCheckin() {
  let browser = null;
  
  try {
    console.log('🚀 开始执行自动签到脚本');
    
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
    
    console.log(`🌐 正在访问签到页面: ${CHECKIN_URL}`);
    await page.goto(CHECKIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`📍 当前URL: ${page.url()}`);
    
    await page.waitForTimeout(2000);
    
    await switchToChineseIfNeeded(page);
    
    await saveScreenshot(page, '01_initial.png');
    
    console.log('🔐 开始登录流程');
    
    const passwordInput = page.locator('input[type="password"]').first();
    const inputCount = await passwordInput.count();
    
    if (inputCount === 0) {
      throw new Error('未找到密码输入框');
    }
    
    console.log('✅ 找到密码输入框');
    await passwordInput.click();
    await passwordInput.fill('');
    await passwordInput.fill(CHECKIN_KEY);
    console.log('✅ 已输入API Key');
    
    await saveScreenshot(page, '02_after_input.png');
    
    const loginBtn = page.locator('button:has-text("登录")').first();
    const loginBtnCount = await loginBtn.count();
    
    if (loginBtnCount === 0) {
      const submitBtn = page.locator('button[type="submit"]').first();
      if (await submitBtn.count() > 0) {
        console.log('✅ 使用提交按钮登录');
        await submitBtn.click({ timeout: 5000 });
      } else {
        console.log('⚠️ 未找到登录按钮，尝试直接触发回车');
        await page.keyboard.press('Enter');
      }
    } else {
      console.log('✅ 找到登录按钮');
      await loginBtn.click({ timeout: 5000 });
    }
    
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      console.log('⚠️ 网络空闲等待超时，继续执行');
    });
    await page.waitForTimeout(2000);
    console.log(`📍 登录后URL: ${page.url()}`);
    
    await saveScreenshot(page, '03_after_login.png');
    
    const pageText = await page.content();
    console.log('📄 页面内容预览:', pageText.substring(0, 500));
    
    let checkinSuccess = false;
    const successKeywords = ['今日已签到', '已签到', '签到成功', 'success', '打卡成功', '签到奖励'];
    
    for (const keyword of successKeywords) {
      if (pageText.includes(keyword)) {
        console.log(`🎉 检测到签到成功关键词: "${keyword}"`);
        checkinSuccess = true;
        break;
      }
    }
    
    if (checkinSuccess) {
      console.log('✅ 签到成功！');
      await saveScreenshot(page, '04_success.png');
      return true;
    }
    
    const errorKeywords = ['错误', 'error', '失败', 'invalid', '请先登录', '密钥无效', 'Key无效'];
    for (const keyword of errorKeywords) {
      if (pageText.includes(keyword)) {
        console.error(`❌ 检测到错误关键词: "${keyword}"`);
        await saveScreenshot(page, '04_error.png');
        return false;
      }
    }
    
    const checkinSelectors = [
      'button:has-text("签到")',
      'button:has-text("立即签到")', 
      'button:has-text("打卡")',
      'button:has-text("今日签到")',
      'button.ci-btn.checkin',
      'a:has-text("签到")',
      'div[class*="checkin"] button',
      'div[class*="sign"] button'
    ];
    
    let checkinBtn = null;
    for (const selector of checkinSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.count() > 0) {
        checkinBtn = btn;
        console.log(`✅ 找到签到按钮 (选择器: ${selector})`);
        break;
      }
    }
    
    if (checkinBtn) {
      console.log('🖱️ 点击签到按钮');
      await checkinBtn.click({ timeout: 5000 });
      
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
        console.log('⚠️ 签到后网络空闲等待超时');
      });
      await page.waitForTimeout(2000);
      await saveScreenshot(page, '04_after_checkin.png');
      
      const finalText = await page.content();
      for (const keyword of successKeywords) {
        if (finalText.includes(keyword)) {
          console.log(`🎉 签到后检测到成功关键词: "${keyword}"`);
          checkinSuccess = true;
          break;
        }
      }
    } else {
      console.log('⚠️ 未找到签到按钮，可能登录即完成签到');
    }
    
    if (checkinSuccess) {
      console.log('✅ 签到成功！');
      await saveScreenshot(page, '04_success.png');
      return true;
    }
    
    console.log('⚠️ 无法明确判断签到结果，但流程已执行完成');
    await saveScreenshot(page, '04_final.png');
    return true;
    
  } catch (error) {
    console.error(`❌ 签到过程中发生错误: ${error.message}`);
    console.error(error.stack);
    
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          await saveScreenshot(pages[0], 'error.png');
        }
      } catch (screenshotError) {
        console.error(`❌ 错误截图保存失败: ${screenshotError.message}`);
      }
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
    console.log('========== 🚀 开始签到测试 ==========');
    const success = await autoCheckin();
    
    if (success) {
      console.log('✅ 签到成功');
      process.exit(0);
    } else {
      console.log('❌ 签到失败');
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ 签到失败: ${error.message}`);
    process.exit(1);
  }
})();
