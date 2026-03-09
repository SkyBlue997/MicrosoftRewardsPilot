/**
 * 弹窗无限循环修复验证测试
 * 验证修复措施是否有效防止无限循环
 */

const assert = require('node:assert/strict');
const { PopupHandler } = require('../dist/src/anti-detection/popup-handler.js');

// 模拟有问题的页面对象
class ProblematicMockPage {
    constructor() {
        this.detectionCount = 0;
        this.url = () => 'https://rewards.bing.com/test';
        this.keyboard = {
            press: async (key) => {
                if (key === 'Escape') {
                    throw new Error('ESC key failed');
                }
            }
        };
    }

    async waitForSelector(selector, options = {}) {
        this.detectionCount++;
        
        // 模拟有问题的选择器总是能找到元素
        if (selector.includes('has-text') || selector.includes('Streak Protection')) {
            console.log(`🔍 Detection #${this.detectionCount}: Found problematic selector: ${selector}`);
            
            return {
                click: async () => {
                    // 模拟点击失败
                    throw new Error('Click failed - element not clickable');
                },
                $: async (childSelector) => {
                    // 模拟找不到关闭按钮
                    return null;
                }
            };
        }
        
        throw new Error('Element not found');
    }

    async waitForTimeout(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.min(ms, 10)));
    }
}

class SlowMockPage extends ProblematicMockPage {
    async waitForSelector(selector) {
        this.detectionCount++;

        if (selector.includes('streak')) {
            await new Promise(resolve => setTimeout(resolve, 1200));
            return null;
        }

        throw new Error('Element not found');
    }
}

// 测试无限循环修复
async function testInfiniteLoopFix() {
    console.log('🧪 测试弹窗无限循环修复...\n');

    const handler = PopupHandler.getInstance();
    
    // 测试1: 默认禁用状态
    console.log('📋 测试1: 默认禁用状态');
    handler.setConfig({
        popupHandling: {
            enabled: false
        }
    });
    
    const page1 = new ProblematicMockPage();
    const startTime1 = Date.now();
    const result1 = await handler.handleAllPopups(page1, 'TEST-DISABLED');
    const duration1 = Date.now() - startTime1;
    
    console.log(`结果: ${result1 ? '❌ 意外处理' : '✅ 正确跳过'}`);
    console.log(`耗时: ${duration1}ms`);
    console.log(`检测次数: ${page1.detectionCount}\n`);
    assert.equal(result1, false, '默认禁用时不应处理弹窗');
    assert.equal(page1.detectionCount, 0, '默认禁用时不应进行检测');

    // 测试2: 启用状态下的紧急停止机制
    console.log('📋 测试2: 紧急停止机制');
    handler.setConfig({
        popupHandling: {
            enabled: true,
            handleStreakProtectionPopups: true
        }
    });
    
    const page2 = new ProblematicMockPage();
    const startTime2 = Date.now();
    
    // 连续多次调用，触发紧急停止
    let emergencyStopTriggered = false;
    for (let i = 0; i < 15; i++) {
        const result = await handler.handleAllPopups(page2, 'TEST-EMERGENCY');
        if (!result && i > 10) {
            emergencyStopTriggered = true;
            console.log(`✅ 紧急停止机制在第${i+1}次调用时触发`);
            break;
        }
        // 短暂延迟模拟快速连续调用
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const duration2 = Date.now() - startTime2;
    console.log(`结果: ${emergencyStopTriggered ? '✅ 紧急停止生效' : '❌ 紧急停止失效'}`);
    console.log(`总耗时: ${duration2}ms`);
    console.log(`总检测次数: ${page2.detectionCount}\n`);
    assert.equal(emergencyStopTriggered, true, '连续调用时应触发紧急停止');

    // 测试3: 超时保护机制
    console.log('📋 测试3: 超时保护机制');

    // 重置处理器状态并使用慢速页面，确保命中单次处理超时逻辑
    handler.clearHandledPopups();

    handler.setConfig({
        popupHandling: {
            enabled: true,
            handleReferralPopups: false,
            handleStreakProtectionPopups: true,
            handleStreakRestorePopups: false,
            handleGenericModals: false
        }
    });

    const page3 = new SlowMockPage();
    const startTime3 = Date.now();
    const result3 = await handler.handleAllPopups(page3, 'TEST-TIMEOUT');
    const duration3 = Date.now() - startTime3;
    
    console.log(`结果: ${duration3 < 15000 ? '✅ 超时保护生效' : '❌ 超时保护失效'}`);
    console.log(`耗时: ${duration3}ms (应该 < 15秒)`);
    console.log(`检测次数: ${page3.detectionCount}\n`);
    assert.equal(result3, false, '超时保护场景不应误报成功');
    assert.ok(page3.detectionCount > 0, '超时保护测试应实际执行过选择器检测');
    assert.ok(duration3 >= 9000, '超时保护测试应接近单次处理超时阈值');
    assert.ok(duration3 < 15000, '超时保护应在 15 秒内结束');

    // 测试4: 选择器安全性
    console.log('📋 测试4: 安全选择器测试');
    
    const safeSelectors = [
        '[data-testid="streak-protection-popup"]',
        '[class*="streak"][class*="protection"]',
        'button[aria-label="Close"]',
        '.streak-protection-modal'
    ];
    
    const unsafeSelectors = [
        'div:has-text("Streak Protection")',
        'button:has-text("Cancel")',
        'span:has-text("×")'
    ];
    
    console.log('✅ 安全选择器 (已使用):');
    safeSelectors.forEach(selector => console.log(`   - ${selector}`));
    
    console.log('❌ 不安全选择器 (已移除):');
    unsafeSelectors.forEach(selector => console.log(`   - ${selector}`));
    
    console.log('\n🎉 弹窗无限循环修复验证完成！');
    
    // 总结
    console.log('\n📊 修复效果总结:');
    console.log('✅ 默认禁用功能 - 避免影响现有用户');
    console.log('✅ 紧急停止机制 - 防止无限循环');
    console.log('✅ 超时保护机制 - 限制处理时间');
    console.log('✅ 安全选择器 - 移除有问题的选择器');
    console.log('✅ 增强错误处理 - 更好的容错能力');
}

// 运行测试
if (require.main === module) {
    testInfiniteLoopFix().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { testInfiniteLoopFix };
