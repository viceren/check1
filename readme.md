# 自动签到脚本

这是一个基于GitHub Actions的自动签到脚本，用于定时访问[某token网站](https://gpt.qt.cool/?ref=Ovm8wE)并完成签到操作。

## 功能特点

- 自动访问签到网站
- 自动输入密钥（从GitHub Secrets读取）
- 智能处理滑动验证码
- 完整的日志记录
- 异常处理和重试机制
- 支持定时执行和手动触发

## 项目结构

```
├── checkin.js            # 核心签到脚本（入口，npm run checkin -> node checkin.js）
├── diagnose.js           # 诊断脚本：检查环境、接口连通性、密钥配置
├── debug_captcha.js      # 验证码调试脚本：单独拉取/复现滑块验证码
├── package.json          # 项目依赖与脚本配置
├── .github/
│   └── workflows/
│       └── checkin.yml   # GitHub Actions 工作流配置
├── artifacts/            # 运行截图目录（*.png），会被上传为 Actions 产物
├── checkin.log           # 运行日志（每次执行重建），会被上传为 Actions 产物
├── .env.example          # 本地运行的环境变量示例（复制为 .env 后填写）
└── README.md             # 项目说明文档
```

> 注意：`.env` 与 `checkin.log`、`artifacts/` 属本地/运行时产物，建议加入 `.gitignore`，仅把 `.env.example` 提交到仓库。

## 快速开始

### 1. Fork 本仓库

首先，将本仓库Fork到你自己的GitHub账号下。

### 2. 配置 GitHub Secrets

在你的仓库页面，点击 `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`，添加以下Secret：

- `CHECKIN_KEY`: 签到网站所需的密钥

### 3. 启用 GitHub Actions

在你的仓库页面，点击 `Actions` 标签，然后点击 `I understand my workflows, go ahead and enable them` 按钮启用GitHub Actions。

### 4. 手动触发签到（可选）

在你的仓库页面，点击 `Actions` -> `Auto Checkin` -> `Run workflow` 按钮可以手动触发一次签到。

## 配置说明

### 定时执行时间

默认情况下，脚本会在每天 **UTC 23:31**（即北京时间次日早上 07:31）执行。如果你想修改执行时间，可以编辑 `.github/workflows/checkin.yml` 文件中的 `cron` 表达式：

```yaml
schedule:
  - cron: '31 23 * * *'  # 每天UTC时间23:31执行（北京时间次日07:31）
```

cron表达式的格式为：`分 时 日 月 周`（均为 UTC 时间）。北京时间 = UTC + 8 小时。例如：

- `31 23 * * *`: 每天UTC 23:31（北京时间次日 07:31）
- `0 0 * * *`: 每天UTC 0 点（北京时间早上 8 点）
- `0 16 * * *`: 每天UTC 16 点（北京时间次日凌晨 0 点）

### 环境变量

脚本支持以下环境变量（CI 中通过 Secrets 传入，本地通过 `.env` 文件传入）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CHECKIN_KEY` | 是 | 签到网站所需的密钥。CI 由 Secret 提供；本地写入 `.env`。 |
| `CHECKIN_EMAIL` | 否 | 若账号绑定了邮箱且该站点签到需先完成邮箱绑定，则填写。 |
| `CHECKIN_EMAIL_CODE` | 否 | 与 `CHECKIN_EMAIL` 配套，邮箱收到的验证码。 |
| `LOG_LEVEL` | 否 | 日志级别，可选：error/warn/info/verbose/debug/silly（默认 info）。 |
| `FORCE_RUN` | 否 | 设为 `true` 时忽略「今日已签到」强制执行（CI 手动触发可勾选）。 |
| `SCREENSHOT_DIR` | 否 | 截图存放目录，默认 `artifacts`。 |
| `LOG_FILE` | 否 | 日志文件路径，默认 `checkin.log`。 |

> 仅 `CHECKIN_KEY` 为必填。若账号未开启邮箱绑定，`CHECKIN_EMAIL` 系列可不配置。

## 本地开发与冒烟测试

在推送前先在本地跑一遍，能最快暴露脚本问题（页面改版、验证码算法失效、密钥错误等）。

### 前置条件

- 已安装 **Node.js 22**（与 CI 一致；也可使用其它版本）
- 一个可用的 `CHECKIN_KEY`

### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 安装 Playwright 的 Chromium（脚本用它驱动浏览器）
npx playwright install chromium
#   在 Linux 上还需系统依赖（GitHub Actions 已自动处理 --with-deps）：
#   npx playwright install-deps chromium

# 3. 准备环境变量
cp .env.example .env
#   编辑 .env，填入你的 CHECKIN_KEY（及其它可选项）

# 4. 运行签到（等同 CI 中的 npm run checkin）
npm run checkin
```

### 查看运行结果

- **日志**：运行后生成 `checkin.log`，可直接打开查看，重点关注 `[GapSolver]` 与 `[CaptchaSolver]` 两行——它们会打印缺口求解的 `sliderX` 与置信度。
- **截图**：`artifacts/*.png` 会按步骤保存（`01_initial.png`、`03_after_login.png`、`04_after_checkin_attempt1.png` 等），便于肉眼核对页面是否被正确识别。
- **退出码**：成功 `0`，失败 `1`。CI 的退出码决定是否判定为运行失败。

### 常见问题

- **`playwright` 报错找不到浏览器**：执行 `npx playwright install chromium`。CI 已通过 `npx playwright install --with-deps chromium` 自动安装。
- **Linux 下启动崩溃 / 缺少共享库**：需要 `npx playwright install-deps chromium`（需 sudo 权限）。
- **滑块验证一直失败**：看 `checkin.log` 里 `[GapSolver] 模板匹配最优 x=... ratio=...`，若 `ratio` 接近 1 说明已回退边缘检测兜底，可能站点改版导致 `piece` 字段缺失，需重新核对接口。
- **`CHECKIN_KEY` 错误**：日志会显示登录超时或失败，检查 `.env` 或 Secrets 中的密钥是否过期。

## 注意事项

1. 本脚本仅用于学习和研究目的，请确保你的使用符合相关网站的服务条款。
2. 网站结构可能会发生变化，导致脚本无法正常工作。如果遇到问题，请检查并更新脚本中的选择器和逻辑。
3. 滑动验证码的处理可能不是100%成功，脚本包含了重试机制来提高成功率。

## 故障排除

### 脚本执行失败

1. 在仓库 `Actions` 页面进入对应运行，下载 **`checkin-results-<run号>`** 产物（包含 `checkin.log` 与 `artifacts/*.png`），这是最完整的排错依据。
2. 检查 GitHub Actions 的运行日志（"Show result" 步骤会 `tail -20 checkin.log`）。
3. 确保你已经正确配置了 `CHECKIN_KEY` Secret（或本地 `.env`）。
4. 检查网站是否可以正常访问，以及页面结构（`#renewKey`、`#checkinBtn` 等选择器）是否发生了变化。

### 验证码处理失败

1. 看产物里的 `checkin.log`，定位 `[GapSolver]` / `[CaptchaSolver]` 行，确认 `sliderX` 与 ratio。
2. 对比 `artifacts/` 下的步骤截图，确认滑块是否被正确识别、拖拽是否到位。
3. 网站可能更新了验证码机制（如 `piece` 字段缺失、缺口算法变更），需要更新脚本中的验证码处理逻辑。
4. 脚本已内置 3 次重试（`MAX_CAPTCHA_RETRIES`），可在 `checkin.js` 中调大重试次数。

## 自定义和扩展

如果你需要修改脚本以适应其他网站，可以主要关注以下几个部分：

1. `CHECKIN_URL`: 签到网站的URL
2. 密钥输入框的选择器
3. 滑动验证码的处理逻辑
4. 签到按钮的选择器
5. 签到结果的判断逻辑

## 许可证

[MIT License](LICENSE)
