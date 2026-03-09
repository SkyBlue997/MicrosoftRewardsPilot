/**
 * Passkey设置循环处理测试
 * 验证Passkey检测和绕过功能
 */

const assert = require('node:assert/strict');

// 模拟Login类的Passkey处理方法
class MockLogin {
    constructor(config = {}) {
        this.config = config;
        this.bot = {
            config: config,
            log: (isMobile, prefix, message, level = 'info') => {
                console.log(`[${prefix}] ${message}`);
            }
        };
    }

    // 模拟isPasskeySetupPage方法
    async isPasskeySetupPage(page) {
        // 检查URL特征
        const url = page.url().toLowerCase();
        if (url.includes('passkey') || url.includes('fido') || url.includes('webauthn') || url.includes('authenticator')) {
            return true;
        }
        
        // 检查页面内容特征
        const passkeyTexts = [
            'Set up a passkey',
            'Create a passkey', 
            'passkey',
            'Passkey',
            'Skip for now',
            'Maybe later'
        ];
        
        for (const text of passkeyTexts) {
            if (page.content && page.content.includes(text)) {
                return true;
            }
        }
        
        return false;
    }

    // 模拟attemptPasskeySkip方法
    async attemptPasskeySkip(page) {
        const skipSelectors = [
            '[data-testid="secondaryButton"]',
            'button[value*="skip"]',
            'button[aria-label*="skip"]',
            '.skip-button',
            '#skip-button'
        ];
        
        for (const selector of skipSelectors) {
            if (page.elements && page.elements[selector]) {
                this.bot.log(false, 'LOGIN-PASSKEY', `Found skip button: ${selector}`);
                page.elements[selector].clicked = true;
                if (page.scenario !== 'passkey-loop') {
                    page.pageUrl = 'https://rewards.bing.com';
                    page.content = 'Microsoft Rewards Dashboard';
                }
                return true;
            }
        }
        
        // 尝试ESC键
        if (page.allowEsc) {
            this.bot.log(false, 'LOGIN-PASSKEY', 'Trying ESC key to skip Passkey setup');
            page.escPressed = true;
            page.pageUrl = 'https://rewards.bing.com';
            page.content = 'Microsoft Rewards Dashboard';
            return true;
        }
        
        // 尝试直接导航
        if (page.allowNavigation) {
            this.bot.log(false, 'LOGIN-PASSKEY', 'Attempting direct navigation to rewards page');
            page.navigatedTo = 'https://rewards.bing.com';
            page.pageUrl = page.navigatedTo;
            page.content = 'Microsoft Rewards Dashboard';
            return true;
        }
        
        return false;
    }

    // 模拟handlePasskeySetupLoop方法
    async handlePasskeySetupLoop(page) {
        // 检查是否启用Passkey处理
        if (this.bot.config?.passkeyHandling?.enabled === false) {
            return false;
        }
        
        const maxAttempts = this.bot.config?.passkeyHandling?.maxAttempts || 5;
        let attempts = 0;
        
        while (attempts < maxAttempts) {
            attempts++;
            
            try {
                // 检查是否在Passkey设置页面
                const isPasskeyPage = await this.isPasskeySetupPage(page);
                if (!isPasskeyPage) {
                    this.bot.log(false, 'LOGIN-PASSKEY', 'Not on Passkey setup page, continuing');
                    return false;
                }
                
                this.bot.log(false, 'LOGIN-PASSKEY', `Detected Passkey setup page (attempt ${attempts}/${maxAttempts})`);
                
                // 尝试多种跳过方法
                const skipped = await this.attemptPasskeySkip(page);
                if (skipped) {
                    // 模拟等待页面跳转
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // 检查是否成功跳过
                    const stillOnPasskey = await this.isPasskeySetupPage(page);
                    if (!stillOnPasskey) {
                        this.bot.log(false, 'LOGIN-PASSKEY', 'Successfully skipped Passkey setup');
                        return true;
                    } else {
                        this.bot.log(false, 'LOGIN-PASSKEY', 'Still on Passkey page after skip attempt');
                    }
                } else {
                    this.bot.log(false, 'LOGIN-PASSKEY', 'Failed to find skip option');
                }
                
                // 短暂等待后重试
                await new Promise(resolve => setTimeout(resolve, 50));
                
            } catch (error) {
                this.bot.log(false, 'LOGIN-PASSKEY', `Passkey handling error: ${error}`);
            }
        }
        
        this.bot.log(false, 'LOGIN-PASSKEY', `Failed to bypass Passkey setup after ${maxAttempts} attempts`);
        return false;
    }
}

// 模拟页面对象
class MockPage {
    constructor(scenario) {
        this.scenario = scenario;
        this.elements = {};
        this.content = '';
        this.pageUrl = 'https://login.microsoftonline.com';
        this.allowEsc = false;
        this.allowNavigation = false;
        this.escPressed = false;
        this.navigatedTo = null;
        
        this.setupScenario(scenario);
    }
    
    setupScenario(scenario) {
        switch (scenario) {
            case 'passkey-with-skip-button':
                this.pageUrl = 'https://login.microsoftonline.com/passkey-setup';
                this.content = 'Set up a passkey for your account. Skip for now';
                this.elements['[data-testid="secondaryButton"]'] = { clicked: false };
                break;
                
            case 'passkey-with-esc':
                this.pageUrl = 'https://login.microsoftonline.com/fido-setup';
                this.content = 'Create a passkey to secure your account';
                this.allowEsc = true;
                break;
                
            case 'passkey-with-navigation':
                this.pageUrl = 'https://login.microsoftonline.com/webauthn';
                this.content = 'Passkey setup required';
                this.allowNavigation = true;
                break;
                
            case 'passkey-loop':
                this.pageUrl = 'https://login.microsoftonline.com/passkey-loop';
                this.content = 'Set up a passkey. Skip for now';
                this.elements['[data-testid="secondaryButton"]'] = { clicked: false };
                this.loopCount = 0;
                break;
                
            case 'normal-page':
                this.pageUrl = 'https://rewards.bing.com';
                this.content = 'Microsoft Rewards Dashboard';
                break;
        }
    }
    
    url() {
        return this.pageUrl;
    }
    
    async waitForTimeout(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.min(ms, 10)));
    }
}

// 测试用例
async function testPasskeyHandling() {
    console.log('🧪 开始测试Passkey处理功能...\n');

    // 测试1: 正常页面（无Passkey）
    console.log('📋 测试1: 正常页面检测');
    const login1 = new MockLogin({
        passkeyHandling: { enabled: true, maxAttempts: 5 }
    });
    const page1 = new MockPage('normal-page');
    
    const result1 = await login1.handlePasskeySetupLoop(page1);
    console.log(`结果: ${result1 ? '❌ 意外处理' : '✅ 正确跳过'}\n`);
    assert.equal(result1, false, '正常页面不应触发 Passkey 处理');

    // 测试2: Passkey页面 - 跳过按钮成功
    console.log('📋 测试2: Passkey页面 - 跳过按钮');
    const login2 = new MockLogin({
        passkeyHandling: { enabled: true, maxAttempts: 5 }
    });
    const page2 = new MockPage('passkey-with-skip-button');
    
    const result2 = await login2.handlePasskeySetupLoop(page2);
    console.log(`结果: ${result2 ? '✅ 成功跳过' : '❌ 跳过失败'}`);
    console.log(`跳过按钮被点击: ${page2.elements['[data-testid="secondaryButton"]']?.clicked ? '✅' : '❌'}\n`);
    assert.equal(result2, true, '跳过按钮场景应成功绕过 Passkey');
    assert.equal(page2.elements['[data-testid="secondaryButton"]']?.clicked, true, '跳过按钮应被点击');

    // 测试3: Passkey页面 - ESC键成功
    console.log('📋 测试3: Passkey页面 - ESC键');
    const login3 = new MockLogin({
        passkeyHandling: { enabled: true, maxAttempts: 5 }
    });
    const page3 = new MockPage('passkey-with-esc');
    
    const result3 = await login3.handlePasskeySetupLoop(page3);
    console.log(`结果: ${result3 ? '✅ 成功跳过' : '❌ 跳过失败'}`);
    console.log(`ESC键被按下: ${page3.escPressed ? '✅' : '❌'}\n`);
    assert.equal(result3, true, 'ESC 备选方案应成功绕过 Passkey');
    assert.equal(page3.escPressed, true, 'ESC 应被触发');

    // 测试4: Passkey页面 - 直接导航
    console.log('📋 测试4: Passkey页面 - 直接导航');
    const login4 = new MockLogin({
        passkeyHandling: { enabled: true, maxAttempts: 5 }
    });
    const page4 = new MockPage('passkey-with-navigation');
    
    const result4 = await login4.handlePasskeySetupLoop(page4);
    console.log(`结果: ${result4 ? '✅ 成功跳过' : '❌ 跳过失败'}`);
    console.log(`导航到: ${page4.navigatedTo || '无'}\n`);
    assert.equal(result4, true, '直接导航备选应成功绕过 Passkey');
    assert.equal(page4.navigatedTo, 'https://rewards.bing.com', '应导航到 Rewards 页面');

    // 测试5: 配置禁用
    console.log('📋 测试5: 配置禁用Passkey处理');
    const login5 = new MockLogin({
        passkeyHandling: { enabled: false }
    });
    const page5 = new MockPage('passkey-with-skip-button');
    
    const result5 = await login5.handlePasskeySetupLoop(page5);
    console.log(`结果: ${result5 ? '❌ 意外处理' : '✅ 正确跳过'}\n`);
    assert.equal(result5, false, '禁用配置时不应处理 Passkey');

    // 测试6: 最大尝试次数
    console.log('📋 测试6: 最大尝试次数限制');
    const login6 = new MockLogin({
        passkeyHandling: { enabled: true, maxAttempts: 2 }
    });
    const page6 = new MockPage('passkey-loop'); // 模拟无法跳过的循环
    
    const startTime = Date.now();
    const result6 = await login6.handlePasskeySetupLoop(page6);
    const duration = Date.now() - startTime;
    
    console.log(`结果: ${result6 ? '❌ 意外成功' : '✅ 正确失败'}`);
    console.log(`耗时: ${duration}ms (应该很快完成)\n`);
    assert.equal(result6, false, '无法绕过的循环场景应最终失败');
    assert.ok(duration < 1000, '最大尝试次数限制应快速结束');

    console.log('🎉 Passkey处理功能测试完成！');
    
    // 总结
    console.log('\n📊 功能验证总结:');
    console.log('✅ 正常页面检测 - 不会误判');
    console.log('✅ 跳过按钮处理 - 能找到并点击');
    console.log('✅ ESC键备选方案 - 按钮失败时使用');
    console.log('✅ 直接导航备选 - 其他方法失败时使用');
    console.log('✅ 配置控制 - 可以禁用功能');
    console.log('✅ 重试限制 - 防止无限循环');
}

// 运行测试
if (require.main === module) {
    testPasskeyHandling().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { testPasskeyHandling };
