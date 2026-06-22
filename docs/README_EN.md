<div align="center">

<!-- 言語切替 / Language Switch / 语言切换 -->
**[中文](../README.md)** | **[English](README_EN.md)** | **[日本語](README_JA.md)**

---

# MicrosoftRewardsPilot Automation Script

**Intelligent Microsoft Rewards Points Auto-Collection Tool**

[![GitHub](https://img.shields.io/badge/GitHub-SkyBlue997-blue?style=flat-square&logo=github)](https://github.com/SkyBlue997/MicrosoftRewardsPilot)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Supported-blue?style=flat-square&logo=docker)](https://hub.docker.com)

---

</div>

## Table of Contents

1. [Quick Start](#quick-start)
2. [Main Configuration](#main-configuration)
3. [Troubleshooting & Testing](#troubleshooting--testing)
4. [Core Features](#core-features)
5. [Complete Configuration Example](#complete-configuration-example)
6. [Important Warnings](#important-warnings)

---

## Quick Start

<details>
<summary><strong>Local Deployment</strong> (Click to expand)</summary>

```bash
# 1. Clone Repository
git clone https://github.com/SkyBlue997/MicrosoftRewardsPilot
cd MicrosoftRewardsPilot

# 2. Install Dependencies
npm i

# 3. Configuration
# Copy example configuration files and edit them
cp config/config.json.example config/config.json
cp config/accounts.json.example config/accounts.json

# 4. Build and Run
npm run build
npm start
```

</details>

<details>
<summary><strong>Docker Deployment (Recommended)</strong> (Click to expand)</summary>

```bash
# 1. Prepare Configuration Files
# Copy example configuration files and edit them
cp config/config.json.example config/config.json
cp config/accounts.json.example config/accounts.json

# 2. Build
npm run build

# 3. Start Container
docker compose up -d

# 4. View Logs (Optional)
docker logs -f microsoftrewardspilot
```

**Docker Compose Configuration Example:**

```yaml
services:
  microsoftrewardspilot:
    build: .
    container_name: microsoftrewardspilot
    restart: unless-stopped
    volumes:
      - ./config/accounts.json:/usr/src/microsoftrewardspilot/dist/config/accounts.json
      - ./config/config.json:/usr/src/microsoftrewardspilot/dist/config/config.json
      - ./sessions:/usr/src/microsoftrewardspilot/sessions  # Persist login sessions
    environment:
      - NODE_ENV=production
      - TZ=Asia/Tokyo  # Set according to geographic location
      - CRON_SCHEDULE=0 9,16 * * *  # Prefer odd / non-round / spread-out hours instead of 9,16, to avoid hitting the same instant every day; run_daily.sh additionally layers on 3-85 min of random jitter
      - RUN_ON_START=true  # Run once immediately on container startup
      # Anti-detection: enable rebrowser's Runtime.enable fix (src/rebrowser-env.ts already ships defaults; declared explicitly here for easy override)
      - REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding
      - REBROWSER_PATCHES_UTILITY_WORLD_NAME=util
```
> Geo-location / timezone are controlled by `searchSettings.multiLanguage.autoDetectLocation` and `searchSettings.autoTimezone` in `config.json` (not environment variables).

</details>

---

## Main Configuration

### Basic Settings
```json
{
  "headless": true,           // Run in headless mode
  "parallel": true,           // Execute tasks in parallel
  "clusters": 1,              // Number of clusters
  "globalTimeout": "45min",   // Global timeout duration
  "runOnZeroPoints": false,   // Don't run when zero points available
  "accountDelay": {           // Delay between accounts
    "min": "5min",            // Minimum delay 5 minutes
    "max": "15min"            // Maximum delay 15 minutes
  }
}
```

### Smart Search Configuration
> Search spacing (log-normal delay) and human-like typing are built in; query language auto-localizes per account market (full query banks for ja/en/zh-CN/vi). Tunable keys:
```json
{
  "searchSettings": {
    "useGeoLocaleQueries": true,    // Only affects the X-Rewards-Country/Language headers
    "multiLanguage": {
      "enabled": true,              // Multi-language support
      "autoDetectLocation": true    // Auto-detect location (drives query & timezone localization)
    },
    "autoTimezone": {
      "enabled": true,              // Auto timezone
      "setOnStartup": true          // Set on startup
    }
  }
}
```
### Task Configuration
> Other claimable activities (daily set, check-ins, read-to-earn, puzzles) are auto-claimed and need no toggle.
```json
{
  "workers": {
    "doDesktopSearch": true,   // Desktop search
    "doMobileSearch": true,    // Mobile search (Level 2+)
    "doMorePromotions": true   // Explore on Bing / promotional tasks
  }
}
```

### Popup Handling Configuration
```json
{
  "popupHandling": {
    "enabled": false,                    // Enable popup handling (disabled by default)
    "handleReferralPopups": true,        // Handle referral popups
    "handleStreakProtectionPopups": true,// Handle streak protection popups
    "handleStreakRestorePopups": true,   // Handle streak restore popups
    "handleGenericModals": true,         // Handle generic modals
    "logPopupHandling": true             // Log popup handling
  }
}
```

### Passkey Handling Configuration
```json
{
  "passkeyHandling": {
    "enabled": true,              // Enable Passkey handling
    "maxAttempts": 5              // Maximum attempts
  }
}
```

---

## Troubleshooting & Testing

### **Mobile 2FA Verification Issue**

**Problem:** Mobile tasks prompt for two-factor authentication

**Solution:** Use the specialized 2FA verification assistant tool

```bash
# Run 2FA verification assistant
npx ts-node src/helpers/manual-2fa-helper.ts
```

**Usage Process:**
1. Select language after running the command
2. Enter the email and password to verify
3. Complete 2FA verification steps in the opened browser
4. Wait for OAuth authorization to complete
5. Tool automatically saves mobile session data
6. Re-run automation program, mobile tasks will skip 2FA verification

### **Popup Handling Issue**

**Problem:** Program gets stuck in popup handling, infinite loop occurs

**Symptoms:** Log shows repeated popup detection info
```
[REWARDS-POPUP] 🎯 Detected Streak Protection Popup
[REWARDS-POPUP] 🎯 Detected Streak Protection Popup
```

**Solution:**
1. **Immediate fix**: Disable popup handling in `config/config.json`
```json
{
  "popupHandling": {
    "enabled": false
  }
}
```

2. **Selective enable**: Only enable required popup types
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

### **Passkey Setup Loop Issue**

**Problem:** After login, redirected to Passkey setup page, clicking "Skip for now" causes infinite loop

**Symptoms:** Program stuck after "Starting login process!"

**Solution:** System automatically handles Passkey loop issue
- **Auto detection**: Detect Passkey setup page
- **Multiple bypasses**: Skip button, ESC key, direct navigation
- **Smart retry**: Up to 5 attempts to prevent infinite loop
- **Configurable**: Adjust handling strategy via config

**Config options:**
```json
{
  "passkeyHandling": {
    "enabled": true,
    "maxAttempts": 5
  }
}
```

### **Common Issues**

<details>
<summary><strong>Points Collection Limited/Automation Detected</strong></summary>

**Symptoms:** Several searches in a row earn no points, or point collection looks incomplete
**Explanation:** Most of the time this is NOT detection, but rather:
- **Reward-day reset boundary (around local midnight):** dapi returns an inconsistent snapshot (search/read counters flicker between "already reset" and "old value"). Don't run during this window — run at stable hours (e.g. the morning/evening cron of the script).
- **Today's activities already done:** a second run on the same day is usually +0 (the correct, idempotent behavior).
- **If you really are throttled:** reduce run frequency and avoid many quick logins in a short span; the built-in anti-detection (rebrowser patch, fingerprint consistency, log-normal delays) recovers with normal use.

</details>

<details>
<summary><strong>Geo-location Detection Failure</strong></summary>

**Solution:** Check network connection, ensure access to geo-location API services

</details>

<details>
<summary><strong>Timezone Mismatch</strong></summary>

**Solution:** Check if the `TZ` environment variable is set correctly

</details>

<details>
<summary><strong>Out of Memory</strong></summary>

**Solution:** Restart container or check system resource usage

</details>

### **Docker Troubleshooting**

```bash
# View logs
docker logs microsoftrewardspilot

# Test network connection
docker exec microsoftrewardspilot ping google.com

# Check geo-location (same service used by the code in GeoLanguage.ts)
docker exec microsoftrewardspilot curl -s https://ipapi.co/json
```

---

## Core Features

<table>
<tr>
<td width="50%" valign="top">

### **Supported Tasks**
> The new rewards.bing.com is now a Next.js SPA with no scrapable DOM; this project instead talks to the **dapi backend API** (activities claimed directly) plus real search / visual search.
- **Daily Task Set / Daily Activities / Promotional Tasks** - "click-to-complete" activities auto-claimed via the dapi API (urlreward / read-to-earn / check-in, including daily-quote-style urlreward cards); interactive quizzes that require answering are NOT auto-completed
- **Desktop Search** - Real, human-paced Bing searches; progress read from dapi
- **Mobile Search** - Mobile device simulation (Level 2+, shares the daily search cap with PC)
- **Explore on Bing** - Completed via category search from the rewards flyout
- **Visual Search** - Auto-completes the Bing visual-search activity
- **Daily Check-in** - Web check-in + Bing-app check-in (two independent check-ins)
- **Read to Earn** - Earn points by reading articles

</td>
<td width="50%" valign="top">

### **Smart Features**
- **Multi-Account Support** - Parallel cluster processing
- **Session Storage** - No repeated login, 2FA support
- **dapi Backend Integration** - The new SPA has no scrapable DOM, so the bot uses the Rewards backend API (`prod.rewardsplatform.microsoft.com/dapi`); `rewards.bing.com` is only the login/landing host
- **Geo-location Detection** - IP-based region / coordinates / timezone detection
- **Timezone Synchronization** - Auto-set matching timezone
- **Localization** - Localizes queries per account market and sends the matching `X-Rewards-Language`
- **rebrowser Anti-Detection** - Enables the patch that removes Playwright's `Runtime.enable` CDP leak
- **Fingerprint Consistency** - fingerprint-injector injection + UA/Client-Hints(GREASE) alignment
- **Human-like Behavior** - Per-character typing, variable-direction scrolling, result clicks and dwell
- **Human-like Delays** - Log-normal-distributed search spacing (no hard interval boundaries)
- **Cadence Randomization** - Account-order shuffle, run-start jitter
- **Popup Smart Handling** - Auto-detect and close various Microsoft Rewards popups
- **Passkey Loop Bypass** - Auto-handle Passkey setup loop issues
- **Docker Support** - Containerized deployment
- **Auto Retry** - Smart retry for failed tasks
- **Detailed Logging** - Complete execution records
- **Flexible Configuration** - Rich customization options
- **Chinese Localization** - China accounts search from a built-in zh-CN query bank (one of the fully-localized languages ja/en/zh-CN/vi)

</td>
</tr>
</table>

---

## Complete Configuration Example

> See the repo's `config/config.json.example` for the full template ([Quick Start](#quick-start) already had you `cp` it). Below lists only the keys that actually take effect:

<details>
<summary><strong>Effective config keys</strong> (Click to expand)</summary>

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
    "doDesktopSearch": true,
    "doMobileSearch": true,
    "doMorePromotions": true
  },
  "searchOnBingLocalQueries": true,
  "globalTimeout": "180min",
  "accountDelay": {
    "min": "8min",
    "max": "20min"
  },
  "searchSettings": {
    "useGeoLocaleQueries": true,
    "multiLanguage": {
      "enabled": true,
      "autoDetectLocation": true
    },
    "autoTimezone": {
      "enabled": true,
      "setOnStartup": true,
      "validateMatch": true,
      "logChanges": true
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
    "maxAttempts": 5
  }
}
```

</details>

---

## Important Warnings

<div align="center">

> **Risk Warning**
> Using automation scripts may result in account suspension

> **Safety Recommendations**
> Use moderately, system has automatically enabled all anti-detection features

> **Regular Updates**
> Keep the script updated to the latest version

</div>

---

<div align="center">

**Enjoy using the script!** 

[![Star History Chart](https://img.shields.io/github/stars/SkyBlue997/MicrosoftRewardsPilot?style=social)](https://github.com/SkyBlue997/MicrosoftRewardsPilot)

*If this project helps you, please consider giving it a Star!*

</div> 