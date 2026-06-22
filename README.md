<div align="center">

<!-- 语言切换 / Language Switch / 言語切替 -->
**[中文](README.md)** | **[English](docs/README_EN.md)** | **[日本語](docs/README_JA.md)**

---

# MicrosoftRewardsPilot 自动化脚本

**智能化 Microsoft Rewards 积分自动获取工具**

[![GitHub](https://img.shields.io/badge/GitHub-SkyBlue997-blue?style=flat-square&logo=github)](https://github.com/SkyBlue997/MicrosoftRewardsPilot)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-支持-blue?style=flat-square&logo=docker)](https://hub.docker.com)

---

</div>

## 目录

1. [快速开始](#快速开始)
2. [主要配置](#主要配置)
3. [故障排除与测试](#故障排除与测试)
4. [核心功能](#核心功能)
5. [完整配置示例](#完整配置示例)
6. [重要提醒](#重要提醒)

---

## 快速开始

<details>
<summary><strong>本地运行</strong> （点击展开）</summary>

```bash
# 1. 克隆项目
git clone https://github.com/SkyBlue997/MicrosoftRewardsPilot
cd MicrosoftRewardsPilot

# 2. 安装依赖
npm i

# 3. 配置文件
# 复制示例配置文件并编辑
cp config/config.json.example config/config.json
cp config/accounts.json.example config/accounts.json

# 4. 构建运行
npm run build
npm start
```

</details>

<details>
<summary><strong>Docker 部署（推荐）</strong> （点击展开）</summary>

```bash
# 1. 准备配置文件
# 复制示例配置文件并编辑
cp config/config.json.example config/config.json
cp config/accounts.json.example config/accounts.json

# 2. 构建
npm run build

# 3. 启动容器
docker compose up -d

# 4. 查看日志(可选)
docker logs -f microsoftrewardspilot
```

**Docker Compose 配置示例：**

```yaml
services:
  microsoftrewardspilot:
    build: .
    container_name: microsoftrewardspilot
    restart: unless-stopped
    volumes:
      - ./config/accounts.json:/usr/src/microsoftrewardspilot/dist/config/accounts.json
      - ./config/config.json:/usr/src/microsoftrewardspilot/dist/config/config.json
      - ./sessions:/usr/src/microsoftrewardspilot/sessions  # 保存登录会话
    environment:
      - NODE_ENV=production
      - TZ=Asia/Tokyo  # 根据地理位置设置
      - CRON_SCHEDULE=0 9,16 * * *  # 建议改成不那么"整点"的分散时间，避免每天同一时刻扎堆；run_daily.sh 还会再叠加 3-85 分钟随机抖动
      - RUN_ON_START=true  # 容器启动时立即跑一次
      # 反检测：启用 rebrowser 的 Runtime.enable 修复（src/rebrowser-env.ts 已内置默认值，这里显式声明便于覆盖）
      - REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding
      - REBROWSER_PATCHES_UTILITY_WORLD_NAME=util
```
> 地理位置/时区由 `config.json` 的 `searchSettings.multiLanguage.autoDetectLocation` 与 `searchSettings.autoTimezone` 控制（不是环境变量）。

</details>

---

## 主要配置

### 基础设置
```json
{
  "headless": true,           // 无头模式运行
  "parallel": true,           // 并行执行任务
  "clusters": 1,              // 集群数量
  "globalTimeout": "45min",   // 全局超时时间
  "runOnZeroPoints": false,   // 零积分时不运行
  "accountDelay": {           // 多账户间隔时间
    "min": "5min",            // 最小间隔5分钟
    "max": "15min"            // 最大间隔15分钟
  }
}
```

### 智能搜索配置
> dapi 流程下，搜索间隔由内置的对数正态延迟系统决定（不读 `searchDelay`），打字真实度为固定约 2% 错误率（不读 `humanBehavior`）；查询语言由账户市场自动本地化（ja/en/zh-CN/vi 有完整查询库）。以下为实际生效的键：
```json
{
  "searchSettings": {
    "useGeoLocaleQueries": true,    // 仅影响请求头 X-Rewards-Country/Language
    "multiLanguage": {
      "enabled": true,              // 多语言支持
      "autoDetectLocation": true    // 自动检测位置（决定查询与时区本地化）
    },
    "autoTimezone": {
      "enabled": true,              // 自动时区
      "setOnStartup": true          // 启动时设置
    }
  }
}
```
### 任务配置
> dapi 流程下，实际生效的开关只有 `doDesktopSearch` / `doMobileSearch` / `doMorePromotions`（探索任务）。每日任务集、签到、阅读赚取等可领活动会**自动领取**，对应开关当前为占位（不生效）。
```json
{
  "workers": {
    "doDesktopSearch": true,   // 桌面端搜索（生效）
    "doMobileSearch": true,    // 移动端搜索（生效，L2 起）
    "doMorePromotions": true,  // Explore on Bing / 推广任务（生效）
    "doDailySet": true,        // 每日任务集（自动领取，开关占位）
    "doPunchCards": true,      // 打卡任务（占位）
    "doDailyCheckIn": true,    // 每日签到（自动领取，开关占位）
    "doReadToEarn": true       // 阅读赚取（自动领取，开关占位）
  }
}
```

### 弹窗处理配置
```json
{
  "popupHandling": {
    "enabled": false,                    // 是否启用弹窗处理（默认禁用）
    "handleReferralPopups": true,        // 处理推荐弹窗
    "handleStreakProtectionPopups": true,// 处理连击保护弹窗
    "handleStreakRestorePopups": true,   // 处理连击恢复弹窗
    "handleGenericModals": true,         // 处理通用模态框
    "logPopupHandling": true             // 记录弹窗处理日志
  }
}
```

### Passkey处理配置
```json
{
  "passkeyHandling": {
    "enabled": true,              // 是否启用Passkey处理
    "maxAttempts": 5              // 最大尝试次数
  }
}
```

---

## 故障排除与测试

### **移动端2FA验证问题**

**问题：** 移动端任务执行时提示需要双因素认证

**解决方案：** 使用专门的2FA验证助手工具

```bash
# 运行2FA验证助手
npx ts-node src/helpers/manual-2fa-helper.ts
```

**使用流程：**
1. 运行命令后选择语言
2. 输入需要验证的邮箱和密码
3. 在打开的浏览器中完成2FA验证步骤
4. 等待OAuth授权完成
5. 工具自动保存移动端会话数据
6. 重新运行自动化程序，移动端任务将跳过2FA验证

### **弹窗处理问题**

**问题：** 程序在弹窗处理时卡住不动，出现无限循环

**现象：** 日志显示重复的弹窗检测信息
```
[REWARDS-POPUP]  Detected Streak Protection Popup
[REWARDS-POPUP]  Detected Streak Protection Popup
```

**解决方案：**
1. **立即解决**：在 `config/config.json` 中禁用弹窗处理
```json
{
  "popupHandling": {
    "enabled": false
  }
}
```

2. **选择性启用**：只启用需要的弹窗类型
```json
{
  "popupHandling": {
    "enabled": true,
    "handleReferralPopups": true,
    "handleStreakProtectionPopups": false,
    "handleStreakRestorePopups": false
  }
}
```

### **Passkey设置循环问题**

**问题：** 登录后被重定向到Passkey设置页面，点击"Skip for now"后形成无限循环

**现象：** 程序在 "Starting login process!" 后卡住

**解决方案：** 系统已自动处理Passkey循环问题
- **自动检测**：检测Passkey设置页面
- **多种绕过**：跳过按钮、ESC键、直接导航
- **智能重试**：最多5次尝试，防止无限循环
- **配置控制**：可通过配置调整处理策略

**配置选项：**
```json
{
  "passkeyHandling": {
    "enabled": true,
    "maxAttempts": 5
  }
}
```

### **测试工具**

```bash
# 配置 / 地理 / 时区测试（用项目已装的 ts-node，对应 npm 脚本）
npm run test-config
npm run test-geo
npm run test-timezone

# 以下 JS 测试加载编译产物，运行前需先 npm run build
npm run build
node tests/popup-handler-test.js      # 弹窗处理
node tests/popup-loop-fix-test.js     # 弹窗无限循环修复验证
node tests/passkey-handling-test.js   # Passkey处理
```
> 项目装的是 `ts-node`（非 `tsx`）；直接跑 `.ts` 请用 `npx ts-node <文件>` 或上面的 npm 脚本。

### **常见问题**

<details>
<summary><strong>积分获取受限/检测到自动化行为</strong></summary>

**现象：** 连续多次搜索无积分，或积分获取不完整
**说明：** 多数情况并非被检测，而是：
- **奖励日重置边界（约当地午夜前后）**：dapi 会返回不一致的快照（搜索/阅读在"已重置"和"旧值"间抖动），此时不要跑——在稳定时段（如脚本 cron 的早/晚）运行即可
- **当日活动已完成**：当天第二次运行多为 +0（正确的幂等表现）
- 真被风控时：降低运行频率、避免短时间多次登录，本项目的反检测（rebrowser 补丁、指纹一致性、对数正态延迟、本地化查询）会随正常使用恢复

</details>

<details>
<summary><strong>地理位置检测失败</strong></summary>

**解决方案：** 检查网络连接，确保能访问地理位置API服务

</details>

<details>
<summary><strong>时区不匹配</strong></summary>

**解决方案：** 检查 `TZ` 环境变量设置是否正确

</details>

<details>
<summary><strong>内存不足</strong></summary>

**解决方案：** 重启容器或检查系统资源使用情况

</details>

### **Docker问题排查**

```bash
# 查看日志
docker logs microsoftrewardspilot

# 测试网络连接
docker exec microsoftrewardspilot ping google.com

# 检查地理位置（与代码 GeoLanguage.ts 使用的服务一致）
docker exec microsoftrewardspilot curl -s https://ipapi.co/json
```

---

## 核心功能

<table>
<tr>
<td width="50%" valign="top">

### **支持任务**
> 新版 rewards.bing.com 已迁移为 Next.js SPA，旧的 DOM 抓取失效；本项目改为对接 **dapi 后端 API**（活动直接领取）+ 真实搜索/视觉搜索。
- **每日任务集 / 每日活动 / 推广任务** - 经 dapi API 自动领取「点击即完成」类活动（urlreward / 阅读赚取 / 签到，含每日一言等 urlreward 卡片）；需作答的互动 Quiz 不会被自动完成
- **桌面端搜索** - 真实、拟人节奏的必应搜索，进度读自 dapi
- **移动端搜索** - 移动设备模拟（Level 2 起，与 PC 共享当日搜索上限）
- **Explore on Bing** - 经奖励 flyout 的类目搜索完成
- **视觉搜索** - 自动完成必应视觉搜索活动
- **每日签到** - 网页签到 + 必应应用签到（两种独立签到）
- **阅读赚取** - 阅读文章获取积分

</td>
<td width="50%" valign="top">

### **智能特性**
- **多账户支持** - 集群并行处理
- **会话存储** - 免重复登录，支持2FA
- **dapi 后端对接** - 新版 SPA 已无可抓取 DOM，改走 Rewards 后端 API（`prod.rewardsplatform.microsoft.com/dapi`）；`rewards.bing.com` 仅为登录落地页
- **地理位置检测** - IP 检测地区 / 坐标 / 时区
- **时区同步** - 自动设置匹配时区
- **本地化** - 按账户市场本地化查询，并发送对应 `X-Rewards-Language`
- **rebrowser 反检测** - 启用补丁，消除 Playwright 的 `Runtime.enable` CDP 泄漏
- **指纹一致性** - fingerprint-injector 注入 + UA/Client-Hints(GREASE) 对齐
- **拟人行为** - 逐字打字、可变方向滚动、结果点击与停留
- **拟人延迟** - 对数正态分布的搜索间隔（无区间硬边界）
- **节奏随机化** - 账户顺序洗牌、运行启动时间抖动
- **弹窗智能处理** - 自动检测和关闭各种Microsoft Rewards弹窗
- **Passkey循环绕过** - 自动处理Passkey设置循环问题
- **Docker支持** - 容器化部署
- **自动重试** - 失败任务智能重试
- **详细日志** - 完整的执行记录
- **灵活配置** - 丰富的自定义选项
- **中文本地化** - 中国账户使用 zh-CN 查询库搜索（与日/英/越同为完整本地化语言）

</td>
</tr>
</table>



---

## 完整配置示例

> 与仓库的 `config/config.json.example` 对应（[快速开始](#快速开始)已让你 `cp` 它）。**注意：dapi 流程下以下键为占位、不生效**：`searchDelay`、`scrollRandomResults`、`clickRandomResults`、`retryMobileSearchAmount`、`multiLanguage.fallbackLanguage`/`supportedLanguages`、整个 `chinaRegionAdaptation`、`passkeyHandling.skipPasskeySetup`/`useDirectNavigation`/`logPasskeyHandling`，以及 `workers` 中除 `doDesktopSearch`/`doMobileSearch`/`doMorePromotions` 外的开关（其余活动自动领取）。

<details>
<summary><strong>查看完整 config.json 示例</strong> （点击展开）</summary>

```json
{
  "baseURL": "https://rewards.bing.com",
  "sessionPath": "sessions",
  "headless": true,
  "parallel": false,
  "runOnZeroPoints": false,
  "clusters": 1,
  "saveFingerprint": {
    "mobile": true,
    "desktop": true
  },
  "workers": {
    "doDailySet": true,
    "doMorePromotions": true,
    "doPunchCards": true,
    "doDesktopSearch": true,
    "doMobileSearch": true,
    "doDailyCheckIn": true,
    "doReadToEarn": true
  },
  "searchOnBingLocalQueries": true,
  "globalTimeout": "180min",
  "accountDelay": {
    "min": "8min",
    "max": "20min"
  },
  "searchSettings": {
    "useGeoLocaleQueries": true,
    "scrollRandomResults": true,
    "clickRandomResults": true,
    "searchDelay": {
      "min": "180s",
      "max": "360s"
    },
    "retryMobileSearchAmount": 0,
    "multiLanguage": {
      "enabled": true,
      "autoDetectLocation": true,
      "fallbackLanguage": "ja",
      "supportedLanguages": ["ja", "en", "zh-CN", "ko", "de", "fr", "es"]
    },
    "autoTimezone": {
      "enabled": true,
      "setOnStartup": true,
      "validateMatch": true,
      "logChanges": true
    },
    "chinaRegionAdaptation": {
      "enabled": false,
      "useBaiduTrends": true,
      "useWeiboTrends": true,
      "fallbackToLocalQueries": true
    }
  },
  "logExcludeFunc": [
    "SEARCH-CLOSE-TABS"
  ],
  "webhookLogExcludeFunc": [
    "SEARCH-CLOSE-TABS"
  ],
  "proxy": {
    "proxyGoogleTrends": true,
    "proxyBingTerms": true
  },
  "webhook": {
    "enabled": false,
    "url": ""
  },
  "popupHandling": {
    "enabled": false,
    "handleReferralPopups": true,
    "handleStreakProtectionPopups": true,
    "handleStreakRestorePopups": true,
    "handleGenericModals": true,
    "logPopupHandling": true
  },
  "passkeyHandling": {
    "enabled": true,
    "maxAttempts": 5,
    "skipPasskeySetup": true,
    "useDirectNavigation": true,
    "logPasskeyHandling": true
  }
}
```

</details>


## 重要提醒

<div align="center">

> **风险警告**
> 使用自动化脚本可能导致账户被封禁

> **安全建议**
> 适度使用，系统已自动启用所有反检测功能

> **定期更新**
> 保持脚本为最新版本

</div>

---

<div align="center">

**祝您使用愉快！** 

[![Star History Chart](https://img.shields.io/github/stars/SkyBlue997/MicrosoftRewardsPilot?style=social)](https://github.com/SkyBlue997/MicrosoftRewardsPilot)

*如果这个项目对您有帮助，请考虑给一个 Star！*

</div>

