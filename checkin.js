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
    await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await page.waitForTimeout(2000);
    
    await switchToChineseIfNeeded(page);
    
    await saveScreenshot(page, '01_initial.png');
    
    console.log('🔐 开始登录流程');
    
    const apiKeyInput = page.locator('input#renewKey.ci-input[type="password"]');
    if (await apiKeyInput.count() === 0) {
      throw new Error('未找到API Key输入框');
    }
    
    await apiKeyInput.click();
    await apiKeyInput.fill('');
    await apiKeyInput.fill(CHECKIN_KEY);
    console.log('✅ 已输入API Key');
    
    await saveScreenshot(page, '02_after_input.png');
    
    const loginBtn = page.locator('button.ci-btn.renew:has-text("登录")');
    if (await loginBtn.count() === 0) {
      throw new Error('未找到登录按钮');
    }
    
    console.log('🖱️ 点击登录按钮');
    await loginBtn.click();
    
    await page.waitForTimeout(3000);
    
    await saveScreenshot(page, '03_after_login.png');
    
    const pageText = await page.content();
    
    if (pageText.includes('今日已签到') || pageText.includes('已签到') || 
        pageText.includes('签到成功') || pageText.includes('success')) {
      console.log('🎉 签到成功！');
      return true;
    }
    
    if (pageText.includes('错误') || pageText.includes('error') || 
        pageText.includes('失败') || pageText.includes('invalid')) {
      console.error('❌ 签到可能失败，检查页面内容');
      await saveScreenshot(page, '04_error.png');
      return false;
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
