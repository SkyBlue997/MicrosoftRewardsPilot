import { chromium, Page } from 'rebrowser-playwright'
import * as readline from 'readline'
import { getUserAgent } from '../../utils/UserAgent'

/**
 * 移动端2FA验证辅助工具
 * 专门用于解决移动端Microsoft Rewards登录时的双因素认证问题
 *
 * 特点：
 * - 自动使用最新版本的移动端User-Agent
 * - 只处理移动端会话数据
 * - 保存到标准会话目录 src/sessions/[email]/
 * - 支持中英文界面
 * - 自动禁用FIDO/Passkey提示
 */

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

// 多语言支持
type Language = 'zh' | 'en'

interface LanguageStrings {
    title: string
    subtitle: string
    description: string
    selectLanguage: string
    languageOptions: string
    invalidLanguage: string
    enterEmail: string
    enterPassword: string
    startingBrowser: string
    mobileMode: string
    userAgent: string
    screenSize: string
    loginFlow: string
    navigateToLogin: string
    pageLoaded: string
    waitForEmail: string
    emailFilled: string
    clickedNext: string
    emailStepManual: string
    completeEmailStep: string
    passwordFilled: string
    clickedLogin: string
    passwordStepManual: string
    completePasswordStep: string
    twoFactorStep: string
    twoFactorOptions: string
    smsCode: string
    emailCode: string
    authenticatorApp: string
    passkey: string
    detecting2FA: string
    instruction1: string
    instruction2: string
    instruction3: string
    instruction4: string
    instruction5: string
    complete2FA: string
    checking2FA: string
    twoFactorPassed: string
    twoFactorUncertain: string
    continueIf2FA: string
    oauthStep: string
    navigateToOAuth: string
    checkOAuth: string
    waitingOAuth: string
    oauthSuccess: string
    authCode: string
    verificationComplete: string
    completionMessage: string
    accountReady: string
    sessionReady: string
    cookieCount: string
    sessionSaved: string
    mobileSession: string
    sessionDir: string
    successMessage: string
    notes: string
    note1: string
    note2: string
    note3: string
    saveError: string
    manualSave: string
    sessionData: string
    oauthTimeout: string
    checkPageStatus: string
    detected: string
    pressAnyKey: string
    programEnd: string
    programError: string
    loginError: string
}

const translations: Record<Language, LanguageStrings> = {
    zh: {
        title: 'Microsoft Rewards 移动端2FA验证助手',
        subtitle: '=====================================',
        description: '此工具专门用于处理移动端登录时的双因素认证问题\n完成验证后，移动端任务将能正常运行而无需2FA验证',
        selectLanguage: '请选择语言 / Please select language:',
        languageOptions: '1. 中文\n2. English',
        invalidLanguage: '无效选择，默认使用中文',
        enterEmail: '请输入需要验证的邮箱地址: ',
        enterPassword: '请输入密码: ',
        startingBrowser: '\n开始浏览器会话...',
        mobileMode: '📱 已启动移动端浏览器模式',
        userAgent: '🔍 User-Agent: 移动端 (Android)',
        screenSize: '📐 屏幕尺寸: 412x915 (移动端)',
        loginFlow: '\n=== 开始登录流程 ===',
        navigateToLogin: '1. 导航到Microsoft登录页面...',
        pageLoaded: '2. 等待页面加载完成...',
        waitForEmail: '页面已加载，按Enter继续到邮箱输入步骤...',
        emailFilled: '3. 邮箱已填入，查找提交按钮...',
        clickedNext: '4. 已点击"下一步"按钮',
        emailStepManual: '邮箱输入步骤可能需要手动处理',
        completeEmailStep: '如果需要，请手动完成邮箱输入步骤，然后按Enter继续...',
        passwordFilled: '5. 密码已填入，查找提交按钮...',
        clickedLogin: '6. 已点击"登录"按钮',
        passwordStepManual: '密码输入步骤可能需要手动处理',
        completePasswordStep: '如果需要，请手动完成密码输入步骤，然后按Enter继续...',
        twoFactorStep: '\n=== 2FA处理步骤 ===',
        twoFactorOptions: '现在可能会出现以下2FA选项：',
        smsCode: '- SMS验证码',
        emailCode: '- 邮箱验证码',
        authenticatorApp: '- Authenticator应用',
        passkey: '- Passkey/生物识别',
        detecting2FA: '正在检测2FA方法...',
        instruction1: '1. 如果看到SMS验证码输入框，请输入收到的验证码',
        instruction2: '2. 如果看到邮箱验证码输入框，请检查邮箱并输入验证码',
        instruction3: '3. 如果看到Authenticator号码，请在手机应用中按对应数字',
        instruction4: '4. 如果看到Passkey选项，您可以选择跳过或使用',
        instruction5: '5. 如果需要选择其他验证方法，请点击相应按钮',
        complete2FA: '\n请完成2FA验证步骤，完成后按Enter继续...',
        checking2FA: '检查2FA状态...',
        twoFactorPassed: '✅ 2FA验证似乎已通过',
        twoFactorUncertain: '⚠️ 2FA状态不确定，请检查页面',
        continueIf2FA: '如果2FA还没完成，请继续处理，然后按Enter...',
        oauthStep: '\n=== OAuth授权步骤 ===',
        navigateToOAuth: '7. 导航到OAuth授权页面...',
        checkOAuth: '请检查页面是否需要额外的授权步骤，完成后按Enter继续...',
        waitingOAuth: '8. 等待OAuth授权完成...',
        oauthSuccess: '✅ OAuth授权成功!',
        authCode: '授权码: ',
        verificationComplete: '\n=== 验证完成 ===',
        completionMessage: '✅ 2FA验证和OAuth授权已成功完成\n您的账户现在应该可以正常使用自动化程序了',
        accountReady: '您的账户现在应该可以正常使用自动化程序了',
        sessionReady: '\n会话数据已准备好，您可以将其保存到sessions目录中',
        cookieCount: '会话Cookie数量: ',
        sessionSaved: '💾 移动端会话数据已自动保存!',
        mobileSession: '📄 移动端cookies: ',
        sessionDir: '📁 会话目录: ',
        successMessage: '🚀 移动端会话数据已保存，您现在可以运行自动化程序了',
        notes: '📋 注意：',
        note1: '   - 已保存移动端cookies到标准位置',
        note2: '   - 移动端任务现在应该能跳过2FA验证',
        note3: '   - 如果需要桌面端会话，程序会在首次运行时自动创建',
        saveError: '❌ 自动保存失败: ',
        manualSave: '请手动保存会话数据',
        sessionData: '会话数据:',
        oauthTimeout: '\n❌ OAuth授权未完成或超时',
        checkPageStatus: '请检查页面状态，可能需要手动完成某些步骤',
        detected: '✓ 检测到: ',
        pressAnyKey: '\n按任意键关闭浏览器...',
        programEnd: '\n程序结束',
        programError: '程序出错: ',
        loginError: '登录过程中出现错误: '
    },
    en: {
        title: 'Microsoft Rewards Mobile 2FA Verification Assistant',
        subtitle: '=====================================================',
        description: 'This tool is designed to handle two-factor authentication issues during mobile login\nAfter verification, mobile tasks will run normally without 2FA prompts',
        selectLanguage: 'Please select language / 请选择语言:',
        languageOptions: '1. 中文\n2. English',
        invalidLanguage: 'Invalid selection, using Chinese by default',
        enterEmail: 'Enter the email address to verify: ',
        enterPassword: 'Enter password: ',
        startingBrowser: '\nStarting browser session...',
        mobileMode: '📱 Mobile browser mode activated',
        userAgent: '🔍 User-Agent: Mobile (Android)',
        screenSize: '📐 Screen size: 412x915 (Mobile)',
        loginFlow: '\n=== Login Process ===',
        navigateToLogin: '1. Navigating to Microsoft login page...',
        pageLoaded: '2. Waiting for page to load...',
        waitForEmail: 'Page loaded, press Enter to continue to email input step...',
        emailFilled: '3. Email filled, looking for submit button...',
        clickedNext: '4. Clicked "Next" button',
        emailStepManual: 'Email input step may require manual handling',
        completeEmailStep: 'If needed, manually complete the email input step, then press Enter to continue...',
        passwordFilled: '5. Password filled, looking for submit button...',
        clickedLogin: '6. Clicked "Login" button',
        passwordStepManual: 'Password input step may require manual handling',
        completePasswordStep: 'If needed, manually complete the password input step, then press Enter to continue...',
        twoFactorStep: '\n=== 2FA Processing ===',
        twoFactorOptions: 'The following 2FA options may appear:',
        smsCode: '- SMS verification code',
        emailCode: '- Email verification code',
        authenticatorApp: '- Authenticator app',
        passkey: '- Passkey/Biometric',
        detecting2FA: 'Detecting 2FA methods...',
        instruction1: '1. If you see SMS verification code input, enter the received code',
        instruction2: '2. If you see email verification code input, check your email and enter the code',
        instruction3: '3. If you see Authenticator number, press the corresponding number in your mobile app',
        instruction4: '4. If you see Passkey option, you can choose to skip or use it',
        instruction5: '5. If you need to select other verification methods, click the appropriate button',
        complete2FA: '\nPlease complete the 2FA verification steps, then press Enter to continue...',
        checking2FA: 'Checking 2FA status...',
        twoFactorPassed: '✅ 2FA verification seems to have passed',
        twoFactorUncertain: '⚠️ 2FA status uncertain, please check the page',
        continueIf2FA: 'If 2FA is not complete, please continue processing, then press Enter...',
        oauthStep: '\n=== OAuth Authorization ===',
        navigateToOAuth: '7. Navigating to OAuth authorization page...',
        checkOAuth: 'Please check if the page requires additional authorization steps, then press Enter to continue...',
        waitingOAuth: '8. Waiting for OAuth authorization to complete...',
        oauthSuccess: '✅ OAuth authorization successful!',
        authCode: 'Authorization code: ',
        verificationComplete: '\n=== Verification Complete ===',
        completionMessage: '✅ 2FA verification and OAuth authorization completed successfully\nYour account should now work normally with the automation program',
        accountReady: 'Your account should now work normally with the automation program',
        sessionReady: '\nSession data is ready and can be saved to the sessions directory',
        cookieCount: 'Session cookie count: ',
        sessionSaved: '💾 Mobile session data automatically saved!',
        mobileSession: '📄 Mobile cookies: ',
        sessionDir: '📁 Session directory: ',
        successMessage: '🚀 Mobile session data saved, you can now run the automation program',
        notes: '📋 Notes:',
        note1: '   - Mobile cookies saved to standard location',
        note2: '   - Mobile tasks should now skip 2FA verification',
        note3: '   - Desktop session will be created automatically on first run if needed',
        saveError: '❌ Auto-save failed: ',
        manualSave: 'Please manually save session data',
        sessionData: 'Session data:',
        oauthTimeout: '\n❌ OAuth authorization not completed or timed out',
        checkPageStatus: 'Please check page status, manual completion may be required',
        detected: '✓ Detected: ',
        pressAnyKey: '\nPress any key to close browser...',
        programEnd: '\nProgram ended',
        programError: 'Program error: ',
        loginError: 'Error during login process: '
    }
}

class Manual2FAHelper {
    private language: Language = 'zh'
    private strings: LanguageStrings

    constructor() {
        this.strings = translations['zh'] // 默认中文
        this.loadAccounts()
    }

    private loadAccounts() {
        // 这里可以从配置文件读取账户信息
        // 或者让用户手动输入
        console.log('移动端2FA验证辅助工具')
        console.log('========================')
        console.log('专门解决移动端登录2FA问题')
    }

    async selectLanguage(): Promise<void> {
        console.log('\n' + this.strings.selectLanguage)
        console.log(this.strings.languageOptions)
        
        const choice = await this.askQuestion('\n请输入选项 / Enter option (1-2): ')
        
        switch (choice.trim()) {
            case '1':
                this.language = 'zh'
                break
            case '2':
                this.language = 'en'
                break
            default:
                console.log(this.strings.invalidLanguage)
                this.language = 'zh'
                break
        }
        
        this.strings = translations[this.language]
        console.log('')
    }

    async startManualVerification() {
        await this.selectLanguage()
        
        console.log(this.strings.title)
        console.log(this.strings.subtitle)
        console.log(this.strings.description)
        console.log('')
        
        const email = await this.askQuestion(this.strings.enterEmail)
        const password = await this.askQuestion(this.strings.enterPassword)

        console.log(this.strings.startingBrowser)
        
        const browser = await chromium.launch({
            headless: false, // 显示浏览器界面
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        })

        // 获取最新的移动端User-Agent
        const userAgentData = await getUserAgent(true)

        const context = await browser.newContext({
            userAgent: userAgentData.userAgent,
            viewport: { width: 412, height: 915 }, // 模拟移动端屏幕尺寸
            deviceScaleFactor: 3, // 高分辨率移动设备
            isMobile: true, // 标识为移动设备
            hasTouch: true, // 启用触摸支持
            locale: 'en-US'
        })

        const page = await context.newPage()

        console.log(this.strings.mobileMode)
        console.log(`🔍 User-Agent: ${userAgentData.userAgent}`)
        console.log(this.strings.screenSize)

        try {
            await this.performManualLogin(page, email, password)
        } catch (error) {
            console.error(this.strings.loginError, error)
        } finally {
            console.log(this.strings.pressAnyKey)
            await this.askQuestion('')
            await browser.close()
            rl.close()
        }
    }

    private async performManualLogin(page: Page, email: string, password: string) {
        console.log(this.strings.loginFlow)

        // 禁用FIDO/Passkey提示，减少Passkey弹窗干扰
        await page.route('**/GetCredentialType.srf*', (route: any) => {
            const postData = route.request().postData()
            if (postData) {
                try {
                    const body = JSON.parse(postData)
                    body.isFidoSupported = false
                    route.continue({ postData: JSON.stringify(body) })
                } catch {
                    route.continue()
                }
            } else {
                route.continue()
            }
        })

        // 1. 导航到登录页面
        console.log(this.strings.navigateToLogin)
        await page.goto('https://www.bing.com/rewards/dashboard')
        await page.waitForLoadState('domcontentloaded')

        console.log(this.strings.pageLoaded)
        await this.waitForUser(this.strings.waitForEmail)

        // 2. 输入邮箱
        try {
            const emailField = await page.waitForSelector('input[type="email"]', { timeout: 10000 })
            if (emailField) {
                await emailField.fill(email)
                console.log(this.strings.emailFilled)
                
                const nextButton = await page.waitForSelector('button[type="submit"]', { timeout: 5000 })
                if (nextButton) {
                    await nextButton.click()
                    console.log(this.strings.clickedNext)
                }
            }
        } catch (error) {
            console.log(this.strings.emailStepManual)
        }

        await this.waitForUser(this.strings.completeEmailStep)

        // 3. 输入密码
        try {
            const passwordField = await page.waitForSelector('input[type="password"]', { timeout: 10000 })
            if (passwordField) {
                await passwordField.fill(password)
                console.log(this.strings.passwordFilled)
                
                const nextButton = await page.waitForSelector('button[type="submit"]', { timeout: 5000 })
                if (nextButton) {
                    await nextButton.click()
                    console.log(this.strings.clickedLogin)
                }
            }
        } catch (error) {
            console.log(this.strings.passwordStepManual)
        }

        await this.waitForUser(this.strings.completePasswordStep)

        // 4. 处理2FA
        console.log(this.strings.twoFactorStep)
        console.log(this.strings.twoFactorOptions)
        console.log(this.strings.smsCode)
        console.log(this.strings.emailCode)
        console.log(this.strings.authenticatorApp)
        console.log(this.strings.passkey)
        console.log('')

        await this.handle2FAManually(page)

        // 5. 检查OAuth授权
        console.log(this.strings.oauthStep)
        
        // 导航到OAuth授权页面
        const clientId = '0000000040170455'
        const redirectUrl = 'https://login.live.com/oauth20_desktop.srf'
        const scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
        
        const authorizeUrl = `https://login.live.com/oauth20_authorize.srf?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&scope=${encodeURIComponent(scope)}&state=test&access_type=offline_access&login_hint=${encodeURIComponent(email)}`
        
        console.log(this.strings.navigateToOAuth)
        await page.goto(authorizeUrl)
        
        await this.waitForUser(this.strings.checkOAuth)

        // 6. 等待授权完成
        console.log(this.strings.waitingOAuth)

        let authorizationCode = ''
        const startTime = Date.now()
        // 支持环境变量配置超时时间，默认5分钟
        const timeout = Number(process.env.OAUTH_MAX_WAIT_MS || 300000)
        const timeoutMinutes = Math.round(timeout / 60000)
        console.log(`⏱️ OAuth timeout: ${timeoutMinutes} minutes (可通过 OAUTH_MAX_WAIT_MS 环境变量配置)`)

        while (Date.now() - startTime < timeout) {
            const currentUrl = page.url()
            if (currentUrl.includes('oauth20_desktop.srf') && currentUrl.includes('code=')) {
                const url = new URL(currentUrl)
                authorizationCode = url.searchParams.get('code') || ''
                if (authorizationCode) {
                    const authDuration = Date.now() - startTime
                    console.log(this.strings.oauthSuccess)
                    console.log(`${this.strings.authCode}${authorizationCode.substring(0, 20)}...`)
                    console.log(`⏱️ Authorization completed in ${Math.round(authDuration / 1000)}s`)
                    break
                }
            }
            await page.waitForTimeout(2000)
        }

        if (authorizationCode) {
            console.log(this.strings.verificationComplete)
            console.log(this.strings.completionMessage)
            
            // 保存会话数据
            const cookies = await page.context().cookies()
            const sessionData = {
                cookies: cookies,
                timestamp: new Date().toISOString(),
                email: email
            }
            
            console.log(this.strings.sessionReady)
            console.log(`${this.strings.cookieCount}${cookies.length}`)
            
            // 自动保存会话数据
            try {
                const fs = await import('fs')
                const path = await import('path')
                
                // 使用项目标准的会话保存路径 - sessions/[email]/
                const projectRoot = process.cwd()
                const sessionDir = path.join(projectRoot, 'sessions', email)
                
                // 确保会话目录存在
                if (!fs.existsSync(sessionDir)) {
                    fs.mkdirSync(sessionDir, { recursive: true })
                    console.log(`📁 ${this.language === 'zh' ? '创建会话目录' : 'Created session directory'}: ${sessionDir}`)
                }
                
                // 只保存移动端cookies（因为只有移动端需要2FA验证）
                const mobileCookiesPath = path.join(sessionDir, 'mobile_cookies.json')
                fs.writeFileSync(mobileCookiesPath, JSON.stringify(cookies, null, 2))
                
                console.log(this.strings.sessionSaved)
                console.log(`${this.strings.mobileSession}${mobileCookiesPath}`)
                console.log(`${this.strings.sessionDir}${sessionDir}`)
                
                console.log(this.strings.successMessage)
                console.log(this.strings.notes)
                console.log(this.strings.note1)
                console.log(this.strings.note2)
                console.log(this.strings.note3)
                
            } catch (saveError) {
                console.error(this.strings.saveError, saveError)
                console.log(this.strings.manualSave)
                console.log(this.strings.sessionData)
                console.log(JSON.stringify(sessionData, null, 2))
            }
        } else {
            console.log(this.strings.oauthTimeout)
            console.log(this.strings.checkPageStatus)
        }
    }

    /**
     * 尝试自动关闭Passkey提示（轻量级，专门用于OAuth流程）
     * 基于Login.ts的实现
     */
    private async tryDismissPasskey(page: Page): Promise<void> {
        const passkeySelectors = [
            // 5层检测策略
            '#iLooksGood',                           // Layer 1: "Looks good" button
            '#iCancel',                             // Layer 2: Cancel button
            'input[id="KmsiCheckboxField"]',        // Layer 3: KMSI checkbox
            '#acceptButton',                        // Layer 4: Accept button
            'div[data-value="Fido"]'               // Layer 5: Fido option
        ]

        for (const selector of passkeySelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 500, state: 'visible' })
                if (element) {
                    // 针对KMSI checkbox的特殊处理
                    if (selector === 'input[id="KmsiCheckboxField"]') {
                        const isChecked = await element.isChecked()
                        if (!isChecked) {
                            await element.check({ timeout: 1000 })
                        }
                        // 检查后查找提交按钮
                        const submitBtn = await page.waitForSelector('input[type="submit"]', { timeout: 1000, state: 'visible' })
                        if (submitBtn) {
                            await submitBtn.click({ timeout: 1000 })
                            console.log('✓ Auto-dismissed KMSI prompt')
                        }
                    } else if (selector === 'div[data-value="Fido"]') {
                        // 如果检测到Fido选项，尝试点击"Use a different method"
                        const altMethodBtn = await page.waitForSelector('#signInAnotherWay', { timeout: 500, state: 'visible' })
                        if (altMethodBtn) {
                            await altMethodBtn.click({ timeout: 1000 })
                            console.log('✓ Clicked alternative method to skip Passkey')
                        }
                    } else {
                        await element.click({ timeout: 1000 })
                        console.log(`✓ Auto-dismissed Passkey prompt using: ${selector}`)
                    }
                    await page.waitForTimeout(500)
                }
            } catch {
                // 该选择器未找到，继续下一个
            }
        }
    }

    private async handle2FAManually(page: Page) {
        console.log(this.strings.detecting2FA)

        // 首先尝试自动关闭Passkey提示
        await this.tryDismissPasskey(page)

        // 检查常见的2FA元素（扩展版本，与Login.ts保持一致）
        const checks = [
            { name: 'SMS验证码输入框', selector: 'input[name="otc"]' },
            { name: '邮箱验证码输入框', selector: 'input[name="proofconfirmation"]' },
            { name: 'Authenticator显示号码', selector: '#displaySign' },
            { name: 'Authenticator应用', selector: '#idSpan_SAOTCAS_DescriptionText' },
            { name: 'Passkey页面', selector: '[data-testid="biometricVideo"]' },
            { name: 'Passkey选项', selector: 'div[data-value="Fido"]' },
            { name: '保持登录(KMSI)', selector: '#KmsiCheckboxField' },
            { name: '其他验证方法按钮', selector: 'button:has-text("Use a different method")' },
            { name: '其他验证方法(备选)', selector: '#signInAnotherWay' }
        ]

        for (const check of checks) {
            try {
                const element = await page.waitForSelector(check.selector, { timeout: 2000 })
                if (element && await element.isVisible()) {
                    console.log(`${this.strings.detected}${check.name}`)
                }
            } catch {
                // 元素不存在，继续检查下一个
            }
        }

        console.log(`\n${this.strings.twoFactorOptions}`)
        console.log(this.strings.instruction1)
        console.log(this.strings.instruction2)
        console.log(this.strings.instruction3)
        console.log(this.strings.instruction4)
        console.log(this.strings.instruction5)

        await this.waitForUser(this.strings.complete2FA)

        // 多次检查是否已经通过2FA
        let passed = false
        for (let i = 0; i < 10; i++) {
            try {
                // 检查是否已经到达OAuth页面或Rewards页面
                const currentUrl = page.url()
                if (currentUrl.includes('oauth20_authorize') || 
                    currentUrl.includes('rewards.bing.com') ||
                    await page.waitForSelector('html[data-role-name="RewardsPortal"]', { timeout: 2000 })) {
                    passed = true
                    break
                }
            } catch {
                // 继续等待
            }
            
            console.log(`${this.strings.checking2FA} (${i + 1}/10)`)
            await page.waitForTimeout(3000)
        }

        if (passed) {
            console.log(this.strings.twoFactorPassed)
        } else {
            console.log(this.strings.twoFactorUncertain)
            await this.waitForUser(this.strings.continueIf2FA)
        }
    }

    private async waitForUser(message: string): Promise<void> {
        return new Promise((resolve) => {
            rl.question(message, () => {
                resolve()
            })
        })
    }

    private async askQuestion(question: string): Promise<string> {
        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                resolve(answer)
            })
        })
    }
}

// 如果直接运行此文件
if (require.main === module) {
    const helper = new Manual2FAHelper()
    
    helper.startManualVerification().then(() => {
        console.log('\n程序结束 / Program ended')
        process.exit(0)
    }).catch((error) => {
        console.error('程序出错 / Program error:', error)
        process.exit(1)
    })
}

export default Manual2FAHelper 