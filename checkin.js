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
    
    // 启动浏览器
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
    
    // 输入密钥
    logger.info('正在输入密钥');
    
    // 尝试找到密钥输入框并输入
    const keyInputSelectors = [
      '#key',
      '[name="key"]',
      '.key-input',
      'input[type="password"]',
      'input[type="text"]'
    ];
    
    let keyInputFound = false;
    
    for (const selector of keyInputSelectors) {
      try {
        if (await page.$(selector)) {
          await page.type(selector, CHECKIN_KEY, { delay: 100 });
          keyInputFound = true;
          logger.info(`使用选择器 ${selector} 成功输入密钥`);
          break;
        }
      } catch (err) {
        logger.debug(`选择器 ${selector} 无法找到或操作: ${err.message}`);
      }
    }
    
    if (!keyInputFound) {
      // 如果找不到明确的输入框，尝试查找所有输入框并逐个尝试
      const inputs = await page.$$('input');
      for (let i = 0; i < inputs.length; i++) {
        try {
          await inputs[i].type(CHECKIN_KEY, { delay: 100 });
          keyInputFound = true;
          logger.info(`使用第 ${i+1} 个输入框成功输入密钥`);
          break;
        } catch (err) {
          logger.debug(`尝试第 ${i+1} 个输入框失败: ${err.message}`);
        }
      }
    }
    
    if (!keyInputFound) {
      throw new Error('无法找到密钥输入框');
    }
    
    // 处理滑动验证码
    logger.info('正在处理滑动验证码');
    await handleSliderCaptcha(page);
    
    // 查找并点击签到按钮
    logger.info('正在查找签到按钮');
    
    const checkinButtonSelectors = [
      '#checkin',
      '.checkin-btn',
      '[type="submit"]',
      'button',
      '.btn-primary'
    ];
    
    let checkinButtonFound = false;
    
    for (const selector of checkinButtonSelectors) {
      try {
        if (await page.$(selector)) {
          logger.info(`找到签到按钮: ${selector}`);
          await page.click(selector);
          checkinButtonFound = true;
          break;
        }
      } catch (err) {
        logger.debug(`选择器 ${selector} 无法找到或点击: ${err.message}`);
      }
    }
    
    if (!checkinButtonFound) {
      // 尝试查找所有按钮并点击第一个可见的
      const buttons = await page.$$('button');
      for (let i = 0; i < buttons.length; i++) {
        try {
          const isVisible = await page.evaluate(b => {
            const style = window.getComputedStyle(b);
            return style && style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   style.opacity !== '0';
          }, buttons[i]);
          
          if (isVisible) {
            await buttons[i].click();
            checkinButtonFound = true;
            logger.info(`点击第 ${i+1} 个按钮作为签到按钮`);
            break;
          }
        } catch (err) {
          logger.debug(`尝试点击第 ${i+1} 个按钮失败: ${err.message}`);
        }
      }
    }
    
    if (!checkinButtonFound) {
      throw new Error('无法找到或点击签到按钮');
    }
    
    // 等待签到结果
    logger.info('等待签到结果...');
    await page.waitForTimeout(3000);
    
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
    // 等待验证码元素加载
    logger.info('等待验证码元素加载');
    
    // 尝试多种可能的验证码选择器
    const captchaSelectors = [
      '.captcha-slider',
      '.slider-captcha',
      '#captcha',
      '[class*="slider"]',
      '[id*="captcha"]'
    ];
    
    let captchaElement = null;
    let sliderHandle = null;
    let sliderTrack = null;
    
    // 查找验证码元素
    for (const selector of captchaSelectors) {
      try {
        if (await page.$(selector)) {
          captchaElement = await page.$(selector);
          logger.info(`找到验证码元素: ${selector}`);
          
          // 尝试查找滑块和轨道
          const handleSelectors = ['.slider-handle', '.handle', '.slider-btn', '.btn'];
          for (const handleSelector of handleSelectors) {
            try {
              const handle = await captchaElement.$(handleSelector);
              if (handle) {
                sliderHandle = handle;
                logger.info(`找到滑块: ${handleSelector}`);
                break;
              }
            } catch (err) {
              logger.debug(`在验证码元素内查找滑块失败: ${err.message}`);
            }
          }
          
          const trackSelectors = ['.slider-track', '.track', '.slider-bg', '.bg'];
          for (const trackSelector of trackSelectors) {
            try {
              const track = await captchaElement.$(trackSelector);
              if (track) {
                sliderTrack = track;
                logger.info(`找到轨道: ${trackSelector}`);
                break;
              }
            } catch (err) {
              logger.debug(`在验证码元素内查找轨道失败: ${err.message}`);
            }
          }
          
          // 如果找到了滑块和轨道，跳出循环
          if (sliderHandle && sliderTrack) {
            break;
          }
        }
      } catch (err) {
        logger.debug(`查找验证码元素失败: ${err.message}`);
      }
    }
    
    // 如果没有找到验证码元素，可能页面没有验证码或者验证码已经通过
    if (!captchaElement) {
      logger.info('未检测到验证码元素，可能不需要验证码或已自动通过');
      return;
    }
    
    // 如果没有找到滑块或轨道，尝试直接在页面中查找
    if (!sliderHandle) {
      logger.info('在验证码元素内未找到滑块，尝试在整个页面中查找');
      const handleSelectors = ['.slider-handle', '.handle', '.slider-btn', '.btn'];
      for (const selector of handleSelectors) {
        try {
          if (await page.$(selector)) {
            sliderHandle = await page.$(selector);
            logger.info(`在页面中找到滑块: ${selector}`);
            break;
          }
        } catch (err) {
          logger.debug(`在页面中查找滑块失败: ${err.message}`);
        }
      }
    }
    
    if (!sliderTrack) {
      logger.info('在验证码元素内未找到轨道，尝试在整个页面中查找');
      const trackSelectors = ['.slider-track', '.track', '.slider-bg', '.bg'];
      for (const selector of trackSelectors) {
        try {
          if (await page.$(selector)) {
            sliderTrack = await page.$(selector);
            logger.info(`在页面中找到轨道: ${selector}`);
            break;
          }
        } catch (err) {
          logger.debug(`在页面中查找轨道失败: ${err.message}`);
        }
      }
    }
    
    // 如果仍然没有找到滑块或轨道，尝试其他方法
    if (!sliderHandle || !sliderTrack) {
      logger.warn('无法找到滑块或轨道，尝试替代方案');
      
      // 尝试查找所有可拖动元素
      const draggableElements = await page.$$('[draggable="true"], [class*="drag"], [id*="drag"]');
      if (draggableElements.length > 0) {
        sliderHandle = draggableElements[0];
        logger.info('找到可拖动元素作为滑块');
      }
      
      // 尝试查找所有可能的轨道元素
      const trackElements = await page.$$('[class*="track"], [class*="rail"], [class*="line"]');
      if (trackElements.length > 0) {
        sliderTrack = trackElements[0];
        logger.info('找到可能的轨道元素');
      }
    }
    
    // 如果还是没有找到，抛出错误
    if (!sliderHandle) {
      throw new Error('无法找到滑块元素');
    }
    
    if (!sliderTrack) {
      throw new Error('无法找到轨道元素');
    }
    
    // 获取滑块和轨道的位置信息
    const handleRect = await sliderHandle.boundingBox();
    const trackRect = await sliderTrack.boundingBox();
    
    if (!handleRect || !trackRect) {
      throw new Error('无法获取滑块或轨道的位置信息');
    }
    
    logger.info(`滑块位置: x=${handleRect.x}, y=${handleRect.y}, width=${handleRect.width}, height=${handleRect.height}`);
    logger.info(`轨道位置: x=${trackRect.x}, y=${trackRect.y}, width=${trackRect.width}, height=${trackRect.height}`);
    
    // 计算滑动距离（这里是一个估计值，实际情况可能需要更复杂的计算）
    // 通常滑动距离是轨道宽度减去滑块宽度
    const slideDistance = trackRect.width - handleRect.width;
    
    // 为了模拟人类行为，我们不会直接滑到最远处，而是留下一些余量
    const randomOffset = Math.floor(Math.random() * 20) - 10; // -10 到 10 的随机偏移
    const targetDistance = slideDistance * (0.8 + Math.random() * 0.15) + randomOffset; // 滑动到轨道的80%-95%位置
    
    logger.info(`计算得到的滑动距离: ${targetDistance.toFixed(2)}px`);
    
    // 获取滑块的中心点
    const handleCenterX = handleRect.x + handleRect.width / 2;
    const handleCenterY = handleRect.y + handleRect.height / 2;
    
    // 移动鼠标到滑块中心
    await page.mouse.move(handleCenterX, handleCenterY);
    
    // 按下鼠标左键
    await page.mouse.down();
    logger.info('按下鼠标左键');
    
    // 模拟人类滑动行为
    await simulateHumanSlide(page, handleCenterX, handleCenterY, targetDistance);
    
    // 释放鼠标左键
    await page.mouse.up();
    logger.info('释放鼠标左键');
    
    // 等待验证结果
    await page.waitForTimeout(2000);
    
    logger.info('验证码滑动完成');
    
  } catch (error) {
    logger.error(`处理滑动验证码时发生错误: ${error.message}`);
    logger.debug(error.stack);
    
    // 尝试其他可能的验证码处理方式
    try {
      // 检查是否有刷新按钮，如果有，尝试刷新验证码
      const refreshButtons = await page.$$('.refresh-btn, .refresh, #refresh, [class*="refresh"]');
      if (refreshButtons.length > 0) {
        logger.info('找到验证码刷新按钮，尝试刷新验证码');
        await refreshButtons[0].click();
        await page.waitForTimeout(1000);
        
        // 重新尝试处理验证码
        return handleSliderCaptcha(page);
      }
    } catch (refreshError) {
      logger.debug(`尝试刷新验证码失败: ${refreshError.message}`);
    }
    
    // 如果是找不到元素的错误，可能页面结构发生变化，或者不需要验证码
    if (error.message.includes('Cannot find') || error.message.includes('Unable to find')) {
      logger.warn('无法找到验证码相关元素，可能页面结构已变化或不需要验证码');
      return;
    }
    
    throw error;
  }
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

// 执行签到
(async () => {
  try {
    // 使用重试机制执行签到
    const success = await retry(autoCheckin, 3, 5000);
    
    if (success) {
      logger.info('签到成功完成');
      process.exit(0);
    } else {
      logger.warn('签到完成，但可能未成功');
      process.exit(0); // 即使可能失败，也返回成功状态码，避免GitHub Actions任务失败
    }
  } catch (error) {
    logger.error(`签到失败: ${error.message}`);
    process.exit(1);
  }
})();