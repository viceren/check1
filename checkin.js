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

async function handleSliderCaptcha(page) {
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.waitForTimeout(1000);
      
      const sliderPatterns = [
        { container: 'div[class*="nc_wrapper"]', slider: '[class*="nc_iconfont"]' },
        { container: 'div[id*="nc_wrapper"]', slider: '[class*="slider"]' },
        { container: '.geetest_slider', slider: '.geetest_slider_button' },
        { container: '[class*="captcha"]', slider: '[class*="slider"]' }
      ];
      
      for (const pattern of sliderPatterns) {
        const container = page.locator(pattern.container).first();
        if (await container.count() > 0) {
          console.log(`🔍 检测到滑动验证码容器 (尝试 ${attempt}/${maxRetries})`);
          await saveScreenshot(page, `captcha_${attempt}.png`);
          
          const slider = container.locator(pattern.slider).first();
          if (await slider.count() > 0) {
            const sliderBox = await slider.boundingBox();
            if (sliderBox) {
              console.log('🖱️ 开始模拟滑动验证码');
              
              const startX = sliderBox.x + sliderBox.width / 2;
              const startY = sliderBox.y + sliderBox.height / 2;
              
              const distance = Math.random() * 50 + 250;
              
              await page.mouse.move(startX, startY);
              await page.waitForTimeout(100);
              
              await page.mouse.down();
              await page.waitForTimeout(50);
              
              const steps = 20;
              const moveDistance = distance / steps;
              
              for (let i = 1; i <= steps; i++) {
                const progress = i / steps;
                const easedDistance = moveDistance * (1 + Math.sin(progress * Math.PI) * 0.5);
                const randomOffset = (Math.random() - 0.5) * 3;
                await page.mouse.move(
                  startX + easedDistance * i + randomOffset,
                  startY + (Math.random() - 0.5) * 2
                );
                await page.waitForTimeout(30 + Math.random() * 30);
              }
              
              await page.mouse.up();
              await page.waitForTimeout(2000);
              
              console.log('✅ 滑动验证码已完成');
              return true;
            }
          }
        }
      }
      
      return false;
      
    } catch (error) {
      console.error(`❌ 滑动验证码处理失败 (尝试 ${attempt}/${maxRetries}): ${error.message}`);
      if (attempt < maxRetries) {
        await page.waitForTimeout(1000);
      }
    }
  }
  
  console.log('⚠️ 滑动验证码处理失败，但继续执行');
  return false;
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
    
    await handleSliderCaptcha(page);
    
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
    
    await handleSliderCaptcha(page);
    
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      console.log('⚠️ 网络空闲等待超时，继续执行');
    });
    await page.waitForTimeout(2000);
    console.log(`📍 登录后URL: ${page.url()}`);
    
    await saveScreenshot(page, '03_after_login.png');
    
    let checkinSuccess = false;
    let alreadyCheckedIn = false;
    const successKeywords = ['今日已签到', '已签到', '签到成功', 'success', '打卡成功', '签到奖励'];
    const alreadySignedKeywords = ['今日已签到', '已签到', '已打卡'];
    
    const pageText = await page.content();
    console.log('📄 页面内容预览:', pageText.substring(0, 500));
    
    for (const keyword of successKeywords) {
      if (pageText.includes(keyword)) {
        console.log(`🎉 检测到签到成功关键词: "${keyword}"`);
        checkinSuccess = true;
        break;
      }
    }
    
    for (const keyword of alreadySignedKeywords) {
      if (pageText.includes(keyword)) {
        console.log(`ℹ️ 检测到已签到状态: "${keyword}"`);
        alreadyCheckedIn = true;
        break;
      }
    }
    
    if (checkinSuccess || alreadyCheckedIn) {
      console.log('✅ 签到流程完成！');
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
    
    if (!checkinBtn) {
      console.log('⚠️ 未找到签到按钮，尝试查找其他交互元素');
      const possibleBtns = await page.locator('button, a, [role="button"]').all();
      for (const btn of possibleBtns) {
        const text = await btn.textContent();
        if (text && text.trim().length > 0 && text.trim().length < 20) {
          console.log(`  可疑元素: "${text.trim()}"`);
        }
      }
    }
    
    if (checkinBtn) {
      console.log('🖱️ 点击签到按钮');
      await checkinBtn.click({ timeout: 5000 });
      
      await handleSliderCaptcha(page);
      
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
      
      if (!checkinSuccess) {
        for (const keyword of alreadySignedKeywords) {
          if (finalText.includes(keyword)) {
            console.log(`ℹ️ 签到后检测到已签到状态: "${keyword}"`);
            alreadyCheckedIn = true;
            break;
          }
        }
      }
    } else {
      console.error('❌ 未找到可点击的签到按钮');
      await saveScreenshot(page, '04_no_button.png');
      return false;
    }
    
    if (checkinSuccess || alreadyCheckedIn) {
      console.log('✅ 签到成功！');
      await saveScreenshot(page, '04_success.png');
      return true;
    }
    
    console.error('❌ 无法确认签到结果，可能执行失败');
    await saveScreenshot(page, '04_failed.png');
    return false;
    
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
