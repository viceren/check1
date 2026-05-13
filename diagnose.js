const { chromium } = require('playwright');
const fs = require('fs');

const CHECKIN_KEY = process.env.CHECKIN_KEY || 'sk-user-vZpufoEqFIKTd5iGnIlmFMOGIWXw1G0r';
const CHECKIN_URL = 'https://gpt.qt.cool/checkin';

async function diagnose() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  fs.mkdirSync('artifacts', { recursive: true });

  console.log('=== 1. 访问签到页面 ===');
  await page.goto(CHECKIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('URL:', page.url());

  const initialHtml = await page.content();
  fs.writeFileSync('artifacts/01_initial.html', initialHtml);
  await page.screenshot({ path: 'artifacts/01_initial.png', fullPage: true });

  console.log('\n=== 2. 查找所有输入框 ===');
  const inputs = await page.locator('input').all();
  for (let i = 0; i < inputs.length; i++) {
    const type = await inputs[i].getAttribute('type').catch(() => 'no-type');
    const id = await inputs[i].getAttribute('id').catch(() => 'no-id');
    const name = await inputs[i].getAttribute('name').catch(() => 'no-name');
    const placeholder = await inputs[i].getAttribute('placeholder').catch(() => 'no-placeholder');
    const classes = await inputs[i].getAttribute('class').catch(() => 'no-class');
    console.log(`  Input ${i}: type=${type}, id=${id}, name=${name}, placeholder=${placeholder}, class=${classes}`);
  }

  console.log('\n=== 3. 查找所有按钮 ===');
  const buttons = await page.locator('button').all();
  for (let i = 0; i < buttons.length; i++) {
    const text = await buttons[i].textContent().catch(() => '');
    const id = await buttons[i].getAttribute('id').catch(() => 'no-id');
    const classes = await buttons[i].getAttribute('class').catch(() => 'no-class');
    const type = await buttons[i].getAttribute('type').catch(() => 'no-type');
    console.log(`  Button ${i}: text="${text.trim()}", id=${id}, class=${classes}, type=${type}`);
  }

  console.log('\n=== 4. 查找包含"续期"的元素 ===');
  const renewElements = await page.locator('text=续期').all();
  console.log(`找到 ${renewElements.length} 个包含"续期"的元素`);

  console.log('\n=== 5. 查找包含"签到"的元素 ===');
  const checkinElements = await page.locator('text=签到').all();
  console.log(`找到 ${checkinElements.length} 个包含"签到"的元素`);

  console.log('\n=== 6. 尝试点击"已有密钥续期"区域 ===');
  const renewSection = page.locator('text=已有密钥续期').first();
  if (await renewSection.count() > 0) {
    await renewSection.click();
    console.log('点击了"已有密钥续期"');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'artifacts/02_after_renew_click.png', fullPage: true });

    const afterRenewHtml = await page.content();
    fs.writeFileSync('artifacts/02_after_renew_click.html', afterRenewHtml);

    console.log('\n=== 7. 点击后续期页面的输入框 ===');
    const inputs2 = await page.locator('input').all();
    for (let i = 0; i < inputs2.length; i++) {
      const type = await inputs2[i].getAttribute('type').catch(() => 'no-type');
      const id = await inputs2[i].getAttribute('id').catch(() => 'no-id');
      const name = await inputs2[i].getAttribute('name').catch(() => 'no-name');
      const placeholder = await inputs2[i].getAttribute('placeholder').catch(() => 'no-placeholder');
      const classes = await inputs2[i].getAttribute('class').catch(() => 'no-class');
      console.log(`  Input ${i}: type=${type}, id=${id}, name=${name}, placeholder=${placeholder}, class=${classes}`);
    }

    console.log('\n=== 8. 点击后续期页面的按钮 ===');
    const buttons2 = await page.locator('button').all();
    for (let i = 0; i < buttons2.length; i++) {
      const text = await buttons2[i].textContent().catch(() => '');
      const id = await buttons2[i].getAttribute('id').catch(() => 'no-id');
      const classes = await buttons2[i].getAttribute('class').catch(() => 'no-class');
      const type = await buttons2[i].getAttribute('type').catch(() => 'no-type');
      console.log(`  Button ${i}: text="${text.trim()}", id=${id}, class=${classes}, type=${type}`);
    }

    console.log('\n=== 9. 尝试输入密钥 ===');
    const passwordInput = page.locator('input[type="password"]').first();
    if (await passwordInput.count() > 0) {
      await passwordInput.fill(CHECKIN_KEY);
      console.log('已输入密钥');
      await page.screenshot({ path: 'artifacts/03_after_input.png', fullPage: true });

      console.log('\n=== 10. 查找并点击登录/签到按钮 ===');
      const loginBtn = page.locator('button:has-text("登录"), button:has-text("签到"), button:has-text("续期"), button[type="submit"]').first();
      if (await loginBtn.count() > 0) {
        const btnText = await loginBtn.textContent();
        console.log('找到按钮:', btnText.trim());
        await loginBtn.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'artifacts/04_after_login.png', fullPage: true });

        const finalHtml = await page.content();
        fs.writeFileSync('artifacts/04_after_login.html', finalHtml);

        console.log('\n=== 11. 最终页面分析 ===');
        const finalText = await page.content();
        console.log('页面包含关键词:');
        ['今日已签到', '已签到', '签到成功', 'success', '打卡成功', '签到奖励', '余额', '错误', '失败', 'invalid'].forEach(kw => {
          if (finalText.includes(kw)) console.log(`  ✓ "${kw}"`);
        });

        const finalButtons = await page.locator('button').all();
        console.log(`\n最终页面有 ${finalButtons.length} 个按钮:`);
        for (let i = 0; i < finalButtons.length; i++) {
          const text = await finalButtons[i].textContent().catch(() => '');
          console.log(`  Button ${i}: "${text.trim()}"`);
        }
      } else {
        console.log('未找到登录/签到按钮');
      }
    } else {
      console.log('未找到密码输入框');
    }
  } else {
    console.log('未找到"已有密钥续期"区域');
  }

  await browser.close();
  console.log('\n=== 诊断完成 ===');
}

diagnose().catch(err => {
  console.error('诊断出错:', err);
  process.exit(1);
});
