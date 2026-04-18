/**
 * 自动签到脚本
 * 用于GitHub Actions定时执行，自动访问指定网站完成签到操作
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');

// 配置日志
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(info => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`)
  ),
  transports: [
    new transports.Console(),
    new transports.File({ 
      filename: 'checkin.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// 确保日志目录存在
const logDir = path.dirname('checkin.log');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 签到网站URL
const CHECKIN_URL = 'https://gpt.qt.cool/checkin';

// 获取密钥
const CHECKIN_KEY = process.env.CHECKIN_KEY;
if (!CHECKIN_KEY) {
  logger.error('未设置CHECKIN_KEY环境变量');
  process.exit(1);
}

/**
 * 主签到函数
 */
async function autoCheckin() {
  let browser = null;
  
  try {
    logger.info('开始执行自动签到脚本');
    
    // 启动浏览器（GitHub Actions使用headless模式）
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    });
    
    logger.info('浏览器启动成功');
    
    // 创建新页面
    const page = await browser.newPage();
    
    // 设置用户代理
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36');
    
    // 设置页面超时
    page.setDefaultTimeout(30000);
    
    // 监听页面事件
    page.on('console', msg => logger.debug(`页面日志: ${msg.text()}`));
    page.on('error', err => logger.error(`页面错误: ${err.message}`));
    page.on('pageerror', err => logger.error(`页面JavaScript错误: ${err.message}`));
    
    // 访问签到页面
    logger.info(`正在访问签到页面: ${CHECKIN_URL}`);
    await page.goto(CHECKIN_URL, { 
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    logger.info('页面加载完成');
    
    // 等待页面元素加载
    await page.waitForSelector('body', { timeout: 10000 });
    
    // 检查登录状态...检查登录状态
    // 条件1：有"签到续期"按钮
    // 条件2：没有密码输入框（说明已经登录）
    logger.info('检查登录状态...');
    
    const checkinButtonExists = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent && btn.textContent.includes('签到续期')) {
          return true;
        }
      }
      return false;
    });
    
    const passwordInputExists = await page.evaluate(() => {
      return document.querySelectorAll('input[type="password"]').length > 0;
    });
    
    // 真正的登录状态：有签到按钮 且 没有密码输入框
    const isLoggedIn = checkinButtonExists && !passwordInputExists;
    
    logger.info(`检测状态: 签到按钮=${checkinButtonExists}, 密码输入框=${passwordInputExists}, 已登录=${isLoggedIn}`);
    
    if (isLoggedIn) {
      logger.info('✅ 检测到已登录状态，直接进行签到');
    } else {
      logger.info('🔐 未登录，需要先登录');
      
      // 在右侧"登录签到续期"区域输入密钥
      // 先找到包含"登录签到续期"文本的区域
      const loginSection = await page.$('text=登录签到续期');
      if (!loginSection) {
        logger.warn('未找到"登录签到续期"区域，尝试查找密码输入框');
      }
      
      // 查找右侧区域的密码输入框（通过位置或顺序判断）
      const passwordInputs = await page.$$('input[type="password"]');
      let targetInput = null;
      
      if (passwordInputs.length >= 2) {
        // 如果有多个密码框，选择第二个（右侧的）
        targetInput = passwordInputs[1];
        logger.info('找到右侧密码输入框（第2个）');
      } else if (passwordInputs.length === 1) {
        targetInput = passwordInputs[0];
        logger.info('找到唯一的密码输入框');
      }
      
      if (!targetInput) {
        // 尝试通过其他方式定位右侧输入框
        const allInputs = await page.$$('input');
        for (let i = 0; i < allInputs.length; i++) {
          const input = allInputs[i];
          try {
            // 检查输入框是否在右侧区域（通过父元素判断）
            const isInRightSection = await page.evaluate((el) => {
              // 查找最近的包含"登录签到续期"的父元素
              let parent = el.parentElement;
              while (parent) {
                if (parent.textContent && parent.textContent.includes('登录签到续期')) {
                  return true;
                }
                parent = parent.parentElement;
              }
              return false;
            }, input);
            
            if (isInRightSection) {
              targetInput = input;
              logger.info(`找到右侧区域的输入框（第${i+1}个）`);
              break;
            }
          } catch (err) {
            // 忽略错误
          }
        }
      }
      
      if (!targetInput) {
        throw new Error('无法找到右侧"登录签到续期"区域的密钥输入框');
      }
      
      // 输入密钥
      await targetInput.type(CHECKIN_KEY, { delay: 100 });
      logger.info('成功在右侧区域输入密钥');
      
      // 等待一下确保输入完成
      await page.waitForTimeout(500);
      
      // 查找并点击"登录"按钮
      logger.info('查找登录按钮...');
      
      // 使用 evaluate 查找并点击包含"登录"文字的按钮
      const loginButtonClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent && btn.textContent.trim() === '登录') {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (!loginButtonClicked) {
        throw new Error('无法找到"登录"按钮');
      }
      
      logger.info('点击登录按钮');
      
      // 等待登录完成，页面刷新显示"签到续期"按钮
      logger.info('等待登录完成...');
      await page.waitForTimeout(3000);
      
      // 等待"签到续期"按钮出现
      try {
        await page.waitForFunction(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent && btn.textContent.includes('签到续期')) {
              return true;
            }
          }
          return false;
        }, { timeout: 10000 });
        logger.info('登录成功，检测到"签到续期"按钮');
      } catch (err) {
        logger.warn('等待"签到续期"按钮超时，继续执行');
      }
    }
    
    // 查找并点击"签到续期"按钮
    logger.info('查找签到续期按钮...');
    
    // 先截图记录点击前状态
    await page.screenshot({ path: 'before_click.png', fullPage: true });
    logger.info('已保存点击前截图: before_click.png');
    
    // 优先使用ID选择器（根据用户提供的HTML代码），通过JavaScript点击
    logger.info('尝试通过JavaScript点击签到按钮...');
    const buttonClicked = await page.evaluate(() => {
      // 首先尝试通过ID查找
      const btnById = document.querySelector('#checkinBtn');
      if (btnById) {
        btnById.click();
        return { success: true, method: 'id', text: btnById.textContent };
      }
      
      // 备选：通过class查找
      const btnByClass = document.querySelector('.ci-btn.renew');
      if (btnByClass) {
        btnByClass.click();
        return { success: true, method: 'class', text: btnByClass.textContent };
      }
      
      // 备选：通过文字内容查找
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent && btn.textContent.includes('签到续期')) {
          btn.click();
          return { success: true, method: 'text', text: btn.textContent };
        }
      }
      
      // 尝试调用doCheckin函数
      if (typeof doCheckin === 'function') {
        doCheckin();
        return { success: true, method: 'function', text: 'doCheckin()' };
      }
      
      return { success: false };
    });
    
    if (!buttonClicked.success) {
      throw new Error('无法找到或点击"签到续期"按钮');
    }
    
    logger.info(`✅ 点击签到按钮成功 (${buttonClicked.method}): ${buttonClicked.text}`);
    
    // 等待JavaScript执行和可能的弹窗出现
    await page.waitForTimeout(2000);
    
    // 等待滑动验证码出现
    logger.info('等待滑动验证码出现(最多5秒)...');
    await page.waitForTimeout(3000);
    
    // 截图查看是否出现验证码
    await page.screenshot({ path: 'captcha_check.png', fullPage: true });
    logger.info('已保存验证码检测截图: captcha_check.png');
    
    // 检查是否出现滑动验证码
    const hasCaptcha = await page.evaluate(() => {
      // 检查常见的验证码元素
      const captchaSelectors = [
        '.captcha-slider',
        '.slider-captcha',
        '#captcha',
        '[class*="slider"]',
        '[class*="captcha"]'
      ];
      for (const selector of captchaSelectors) {
        const el = document.querySelector(selector);
        if (el && el.offsetParent !== null) { // 确保元素可见
          return { found: true, selector: selector, visible: true };
        }
      }
      // 检查页面文本是否包含验证码相关文字
      const bodyText = document.body.textContent || '';
      if (bodyText.includes('滑动') || bodyText.includes('验证') || bodyText.includes('captcha')) {
        return { found: true, selector: 'text-match', visible: true };
      }
      return { found: false };
    });
    
    if (hasCaptcha.found) {
      logger.info(`检测到滑动验证码: ${hasCaptcha.selector}`);
      // 再等待3秒确保验证码完全加载
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'captcha_loaded.png', fullPage: true });
      logger.info('已保存验证码加载后截图: captcha_loaded.png');
      
      // 尝试处理验证码
      await handleSliderCaptcha(page);
      
      // 验证码处理后等待更长时间
      await page.waitForTimeout(5000);
      
      // 再次点击签到按钮（验证完成后可能需要再次点击）
      logger.info('验证完成后再次点击签到按钮...');
      await page.evaluate(() => {
        const btn = document.querySelector('#checkinBtn');
        if (btn) btn.click();
      });
      logger.info('再次点击签到按钮');
      await page.waitForTimeout(3000);
    } else {
      logger.info('未检测到滑动验证码，继续等待签到结果');
    }
    
    // 等待签到结果
    logger.info('等待签到结果(最长30秒)...');
    let checkinCompleted = false;
    let lastPageContent = '';
    
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      
      // 每秒截图记录
      if (i % 5 === 0) {
        await page.screenshot({ path: `waiting_${i}s.png`, fullPage: true });
        logger.debug(`已保存等待截图: waiting_${i}s.png`);
      }
      
      // 检查是否出现成功提示
      const pageContent = await page.content();
      lastPageContent = pageContent;
      
      // 检查日历中今天是否有签到标记
      const todayCheckinStatus = await page.evaluate(() => {
        // 获取今天的日期
        const today = new Date().getDate();
        // 查找日历中今天的元素
        const calendarElements = document.querySelectorAll('*');
        for (const el of calendarElements) {
          if (el.textContent && el.textContent.trim() === String(today)) {
            // 检查是否有签到标记（小点或其他标记）
            const parent = el.parentElement;
            if (parent) {
              const hasMark = parent.querySelector('.dot, .checked, .sign, [class*="sign"]');
              return { today: today, hasMark: !!hasMark, html: parent.innerHTML.substring(0, 200) };
            }
          }
        }
        return { today: today, hasMark: false };
      });
      
      if (todayCheckinStatus.hasMark) {
        logger.info(`检测到日历中${todayCheckinStatus.today}号已有签到标记！`);
        checkinCompleted = true;
        break;
      }
      
      if (pageContent.includes('签到成功') || 
          pageContent.includes('今日已签到') ||
          pageContent.includes('已签到') ||
          pageContent.includes('连续签到')) {
        logger.info('检测到签到成功提示');
        checkinCompleted = true;
        break;
      }
      
      // 检查按钮文字是否变成"已签到"或显示连续签到天数
      const currentButtons = await page.$$('button');
      for (const btn of currentButtons) {
        try {
          const text = await page.evaluate(el => el.textContent || el.innerText, btn);
          if (text && (text.includes('已签到') || text.includes('今日已签') || text.includes('连续签到'))) {
            logger.info(`检测到状态变化: ${text.trim()}`);
            checkinCompleted = true;
            break;
          }
        } catch (err) {
          // 忽略错误
        }
      }
      
      if (checkinCompleted) break;
      logger.debug(`等待中... ${i + 1}/30 秒`);
    }
    
    if (!checkinCompleted) {
      logger.warn('等待30秒后仍未检测到明确的签到成功标志');
      // 保存最终页面内容用于调试
      fs.writeFileSync('final_page.html', lastPageContent);
      logger.info('已保存最终页面HTML: final_page.html');
    }
    
    // 额外等待2秒确保页面完全更新
    await page.waitForTimeout(2000);
    
    // 最终截图
    await page.screenshot({ path: 'final_result.png', fullPage: true });
    logger.info('已保存最终结果截图: final_result.png');
    
    // 获取页面内容以分析签到结果
    const pageContent = await page.content();
    
    // 检查常见的签到成功提示
    const successPatterns = [
      '签到成功',
      'checkin success',
      'success',
      '已签到',
      'already checked in',
      '今日已签到',
      'today already checked'
    ];
    
    const failurePatterns = [
      '签到失败',
      'checkin failed',
      'failed',
      'error',
      '验证码错误',
      'captcha error',
      'key错误',
      'invalid key'
    ];
    
    let isSuccess = false;
    let resultMessage = '签到结果未知';
    
    // 检查成功模式
    for (const pattern of successPatterns) {
      if (pageContent.toLowerCase().includes(pattern.toLowerCase())) {
        isSuccess = true;
        resultMessage = `签到成功: 检测到关键词 "${pattern}"`;
        break;
      }
    }
    
    // 如果没有检测到成功，检查失败模式
    if (!isSuccess) {
      for (const pattern of failurePatterns) {
        if (pageContent.toLowerCase().includes(pattern.toLowerCase())) {
          resultMessage = `签到失败: 检测到关键词 "${pattern}"`;
          break;
        }
      }
    }
    
    // 尝试获取页面上的提示信息
    try {
      const alertSelectors = [
        '.alert',
        '.message',
        '.toast',
        '.notification',
        '#message',
        '[role="alert"]'
      ];
      
      for (const selector of alertSelectors) {
        const elements = await page.$$(selector);
        for (const element of elements) {
          const text = await page.evaluate(el => el.textContent || el.innerText, element);
          if (text && text.trim()) {
            resultMessage = `页面提示: ${text.trim()}`;
            break;
          }
        }
      }
    } catch (err) {
      logger.debug(`尝试获取页面提示信息失败: ${err.message}`);
    }
    
    // 记录签到结果
    if (isSuccess) {
      logger.info(resultMessage);
    } else {
      logger.warn(resultMessage);
    }
    
    // 截图保存（可选）
    try {
      await page.screenshot({ path: 'checkin_result.png', fullPage: true });
      logger.info('已保存签到结果截图');
    } catch (err) {
      logger.debug(`截图保存失败: ${err.message}`);
    }
    
    logger.info('自动签到脚本执行完成');
    return isSuccess;
    
  } catch (error) {
    logger.error(`签到过程中发生错误: ${error.message}`);
    logger.debug(error.stack);
    
    // 尝试保存错误页面截图
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          await pages[0].screenshot({ path: 'error_screenshot.png', fullPage: true });
          logger.info('已保存错误页面截图');
        }
      } catch (screenshotError) {
        logger.debug(`错误页面截图保存失败: ${screenshotError.message}`);
      }
    }
    
    throw error;
  } finally {
    // 关闭浏览器
    if (browser) {
      try {
        await browser.close();
        logger.info('浏览器已关闭');
      } catch (err) {
        logger.debug(`浏览器关闭失败: ${err.message}`);
      }
    }
  }
}

/**
 * 处理滑动验证码
 * @param {puppeteer.Page} page - Puppeteer页面实例
 */
async function handleSliderCaptcha(page) {
  try {
    logger.info('🔍 开始处理滑动验证码');
    
    // 首先检查是否有iframe（验证码可能在iframe中）
    const frames = page.frames();
    logger.info(`页面共有 ${frames.length} 个frame`);
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      try {
        const hasCaptcha = await frame.evaluate(() => {
          return document.querySelector('.captcha-slider, .slider-captcha, [class*="slider"], [class*="captcha"]') !== null;
        });
        if (hasCaptcha) {
          logger.info(`在第 ${i} 个frame中找到验证码元素`);
          await handleSliderCaptchaInFrame(frame, page);
          return;
        }
      } catch (e) {
        // 忽略跨域frame的错误
      }
    }
    
    // 在主页面中查找验证码
    await handleSliderCaptchaInFrame(page, page);
    
  } catch (error) {
    logger.error(`❌ 处理滑动验证码时发生错误: ${error.message}`);
    // 不抛出错误，让流程继续
  }
}

/**
 * 在指定frame中处理滑动验证码
 * @param {Frame|Page} frame - Frame或Page实例
 * @param {Page} page - 主页面实例（用于鼠标操作）
 */
async function handleSliderCaptchaInFrame(frame, page) {
  // 查找验证码容器
  const captchaSelectors = [
    '.captcha-slider',
    '.slider-captcha', 
    '#captcha',
    '[class*="slider"]',
    '[class*="captcha"]',
    '[id*="captcha"]'
  ];
  
  let captchaInfo = null;
  
  for (const selector of captchaSelectors) {
    try {
      const element = await frame.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box && box.width > 50 && box.height > 50) {
          captchaInfo = { element, selector, box };
          logger.info(`✅ 找到验证码容器: ${selector} (${box.width}x${box.height})`);
          break;
        }
      }
    } catch (e) {
      // 继续尝试下一个选择器
    }
  }
  
  if (!captchaInfo) {
    logger.warn('⚠️ 未找到验证码容器');
    return;
  }
  
  // 在验证码容器内查找滑块
  const handleSelectors = [
    '.slider-handle',
    '.handle', 
    '[class*="handle"]',
    '[class*="slider"] button',
    '[class*="drag"]'
  ];
  
  let sliderInfo = null;
  
  for (const selector of handleSelectors) {
    try {
      const handle = await captchaInfo.element.$(selector);
      if (handle) {
        const box = await handle.boundingBox();
        if (box) {
          sliderInfo = { handle, selector, box };
          logger.info(`✅ 找到滑块: ${selector} at (${box.x}, ${box.y})`);
          break;
        }
      }
    } catch (e) {
      // 继续尝试
    }
  }
  
  // 如果没找到特定滑块，尝试在验证码区域内查找任何可拖动元素
  if (!sliderInfo) {
    logger.info('🔍 尝试查找任何可拖动元素...');
    const allElements = await captchaInfo.element.$$('*');
    for (const el of allElements) {
      try {
        const box = await el.boundingBox();
        if (box && box.width > 30 && box.width < 100 && box.height > 30 && box.height < 100) {
          sliderInfo = { handle: el, selector: 'auto-detected', box };
          logger.info(`✅ 自动检测到可能的滑块: ${box.width}x${box.height} at (${box.x}, ${box.y})`);
          break;
        }
      } catch (e) {
        // 继续
      }
    }
  }
  
  if (!sliderInfo) {
    logger.warn('⚠️ 未找到滑块元素，尝试JavaScript模拟滑动');
    await simulateSlideWithJavaScript(frame, captchaInfo.box);
    return;
  }
  
  // 执行滑动操作
  await performSlide(page, sliderInfo.box, captchaInfo.box);
}

/**
 * 使用JavaScript模拟滑动
 * @param {Frame|Page} frame - Frame或Page实例  
 * @param {Object} captchaBox - 验证码容器位置
 */
async function simulateSlideWithJavaScript(frame, captchaBox) {
  logger.info('🤖 使用JavaScript模拟滑动验证');
  
  await frame.evaluate((captchaWidth) => {
    // 查找验证码相关元素
    const captchaElements = document.querySelectorAll('[class*="captcha"], [class*="slider"], [id*="captcha"]');
    
    captchaElements.forEach(el => {
      // 触发滑动完成事件
      const startEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY: 0
      });
      
      const moveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: captchaWidth * 0.9, // 滑动到90%位置
        clientY: 0
      });
      
      const endEvent = new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: captchaWidth * 0.9,
        clientY: 0
      });
      
      el.dispatchEvent(startEvent);
      el.dispatchEvent(moveEvent);
      el.dispatchEvent(endEvent);
      
      // 设置验证成功标记
      el.setAttribute('data-verified', 'true');
      
      // 触发验证成功回调
      const verifyEvent = new CustomEvent('verify', { 
        bubbles: true,
        detail: { success: true }
      });
      el.dispatchEvent(verifyEvent);
    });
    
    // 尝试点击任何验证按钮
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
      const text = btn.textContent || '';
      if (text.includes('验证') || text.includes('确认') || text.includes('完成')) {
        btn.click();
      }
    });
  }, captchaBox.width);
  
  logger.info('✅ JavaScript模拟滑动完成');
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * 执行滑动操作
 * @param {Page} page - 页面实例
 * @param {Object} sliderBox - 滑块位置
 * @param {Object} captchaBox - 验证码容器位置
 */
async function performSlide(page, sliderBox, captchaBox) {
  logger.info('🖱️ 开始执行滑动操作');
  
  // 计算滑动距离（滑动到最右边，减去一些余量）
  const slideDistance = captchaBox.width - sliderBox.width - 10;
  
  // 滑块中心点
  const startX = sliderBox.x + sliderBox.width / 2;
  const startY = sliderBox.y + sliderBox.height / 2;
  
  logger.info(`📍 起始位置: (${startX}, ${startY})`);
  logger.info(`📏 滑动距离: ${slideDistance}px`);
  
  // 移动到滑块位置
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  logger.info('⬇️ 按下鼠标');
  
  // 分段滑动，模拟人类行为
  const steps = 10;
  const stepDistance = slideDistance / steps;
  
  for (let i = 1; i <= steps; i++) {
    const currentX = startX + stepDistance * i;
    const randomY = startY + (Math.random() - 0.5) * 5; // 随机Y偏移
    await page.mouse.move(currentX, randomY);
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
  }
  
  await page.mouse.up();
  logger.info('⬆️ 释放鼠标');
  
  // 等待验证完成
  await new Promise(resolve => setTimeout(resolve, 3000));
  logger.info('✅ 滑动操作完成');
}

/**
 * 模拟人类滑动行为
 * @param {puppeteer.Page} page - Puppeteer页面实例
 * @param {number} startX - 起始X坐标
 * @param {number} startY - 起始Y坐标
 * @param {number} distance - 滑动距离
 */
async function simulateHumanSlide(page, startX, startY, distance) {
  // 生成模拟人类滑动的步骤
  const steps = generateHumanLikeSteps(distance);
  
  logger.info(`生成了 ${steps.length} 个滑动步骤`);
  
  // 执行滑动步骤
  for (const step of steps) {
    const newX = startX + step.x;
    const newY = startY + step.y;
    
    await page.mouse.move(newX, newY);
    await page.waitForTimeout(step.delay);
  }
}

/**
 * 生成模拟人类滑动的步骤
 * @param {number} distance - 总滑动距离
 * @returns {Array} 滑动步骤数组
 */
function generateHumanLikeSteps(distance) {
  const steps = [];
  const totalSteps = Math.floor(20 + Math.random() * 20); // 20-40个步骤
  let currentDistance = 0;
  
  // 人类滑动通常分为三个阶段：加速、匀速、减速
  const accelerationPhase = Math.floor(totalSteps * 0.3); // 前30%为加速阶段
  const uniformPhase = Math.floor(totalSteps * 0.5); // 中间50%为匀速阶段
  const decelerationPhase = totalSteps - accelerationPhase - uniformPhase; // 后20%为减速阶段
  
  // 加速阶段
  for (let i = 0; i < accelerationPhase; i++) {
    const progress = i / accelerationPhase;
    const stepDistance = distance * (progress * progress * 0.3); // 加速运动
    const x = stepDistance - currentDistance;
    const y = (Math.random() - 0.5) * 4; // 随机上下抖动
    const delay = Math.floor(5 + Math.random() * 10); // 5-15ms的延迟
    
    steps.push({ x, y, delay });
    currentDistance = stepDistance;
  }
  
  // 匀速阶段
  const uniformSpeed = distance * 0.4 / uniformPhase; // 匀速阶段的速度
  for (let i = 0; i < uniformPhase; i++) {
    const x = uniformSpeed;
    const y = (Math.random() - 0.5) * 3; // 随机上下抖动
    const delay = Math.floor(5 + Math.random() * 8); // 5-13ms的延迟
    
    steps.push({ x, y, delay });
    currentDistance += x;
  }
  
  // 减速阶段
  const remainingDistance = distance - currentDistance;
  for (let i = 0; i < decelerationPhase; i++) {
    const progress = 1 - (i / decelerationPhase);
    const stepDistance = remainingDistance * (progress * progress);
    const x = stepDistance - (remainingDistance * ((1 - ((i + 1) / decelerationPhase)) ** 2));
    const y = (Math.random() - 0.5) * 2; // 随机上下抖动，幅度减小
    const delay = Math.floor(8 + Math.random() * 15); // 8-23ms的延迟，逐渐增加
    
    steps.push({ x, y, delay });
  }
  
  return steps;
}

/**
 * 重试函数
 * @param {Function} fn - 要执行的函数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} delay - 重试间隔（毫秒）
 */
async function retry(fn, maxRetries = 3, delay = 1000) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      logger.warn(`尝试 ${i + 1}/${maxRetries} 失败: ${error.message}`);
      lastError = error;
      
      // 如果还有重试机会，等待一段时间后重试
      if (i < maxRetries - 1) {
        logger.info(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // 所有重试都失败，抛出最后一个错误
  throw lastError;
}

// 执行签到（测试模式：只执行一次，不重试）
(async () => {
  try {
    logger.info('========== 开始签到测试（单次执行） ==========');
    const success = await autoCheckin();
    
    if (success) {
      logger.info('✅ 签到成功完成');
      process.exit(0);
    } else {
      logger.warn('⚠️ 签到完成，但可能未成功');
      process.exit(0);
    }
  } catch (error) {
    logger.error(`❌ 签到失败: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
})();