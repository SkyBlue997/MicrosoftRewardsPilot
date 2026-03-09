/**
 * Microsoft Rewards 弹窗处理系统测试
 * 验证弹窗检测和处理功能
 */

const assert = require('node:assert/strict');
const { PopupHandler } = require('../dist/src/anti-detection/popup-handler.js');

// 模拟页面对象
class MockPage {
    constructor(popups = []) {
        this.popups = popups;
        this.closedPopups = [];
        this.pageUrl = 'https://rewards.bing.com/test';
        this.keyboard = {
            press: async (key) => {
                if (key === 'Escape') {
                    const openPopup = this.popups.find(p => !this.closedPopups.includes(p.id));
                    if (openPopup) {
                        this.closedPopups.push(openPopup.id);
                        console.log(`✅ Closed popup via ESC: ${openPopup.type} (${openPopup.id})`);
                    }
                }
            }
        };
    }

    async waitForSelector(selector, options = {}) {
        const popup = this.popups.find(p => p.selector === selector);
        if (popup && !this.closedPopups.includes(popup.id)) {
            return {
                click: async () => {
                    this.closedPopups.push(popup.id);
                    console.log(`✅ Closed popup: ${popup.type} (${popup.id})`);
                },
                $: async (childSelector) => {
                    if (childSelector.includes('close') || childSelector.includes('Close')) {
                        return {
                            click: async () => {
                                this.closedPopups.push(popup.id);
                                console.log(`✅ Closed popup via child selector: ${popup.type} (${popup.id})`);
                            }
                        };
                    }
                    return null;
                }
            };
        }
        throw new Error('Element not found');
    }

    url() {
        return this.pageUrl;
    }

    async waitForTimeout(ms) {
        // 模拟等待
        return new Promise(resolve => setTimeout(resolve, Math.min(ms, 100)));
    }
}

// 测试用例
async function testPopupHandling() {
    console.log('🧪 开始测试弹窗处理系统...\n');

    const handler = PopupHandler.getInstance();
    handler.clearHandledPopups();
    
    // 设置测试配置
    handler.setConfig({
        popupHandling: {
            enabled: true,
            handleReferralPopups: true,
            handleStreakProtectionPopups: true,
            handleStreakRestorePopups: true,
            handleGenericModals: true,
            logPopupHandling: true
        }
    });

    // 测试1: 推荐弹窗
    console.log('📋 测试1: 推荐弹窗处理');
    const page1 = new MockPage([
        { id: 'ref1', type: 'Referral Popup', selector: '[data-testid="referral-popup"]' }
    ]);
    
    const result1 = await handler.handleAllPopups(page1, 'TEST-1');
    console.log(`结果: ${result1 ? '✅ 成功' : '❌ 失败'}\n`);
    assert.equal(result1, true, '推荐弹窗应该被成功处理');
    assert.deepEqual(page1.closedPopups, ['ref1'], '推荐弹窗应该被关闭');

    // 测试2: 连击保护弹窗
    console.log('📋 测试2: 连击保护弹窗处理');
    const page2 = new MockPage([
        { id: 'streak1', type: 'Streak Protection Popup', selector: '[data-testid="streak-protection-popup"]' }
    ]);
    
    const result2 = await handler.handleAllPopups(page2, 'TEST-2');
    console.log(`结果: ${result2 ? '✅ 成功' : '❌ 失败'}\n`);
    assert.equal(result2, true, '连击保护弹窗应该被成功处理');
    assert.deepEqual(page2.closedPopups, ['streak1'], '连击保护弹窗应该被关闭');

    // 测试3: 多个弹窗
    console.log('📋 测试3: 多个弹窗同时处理');
    const page3 = new MockPage([
        { id: 'ref2', type: 'Referral Popup', selector: '[data-testid="referral-modal"]' },
        { id: 'modal1', type: 'Generic Modal', selector: '.modal[style*="display: block"]' }
    ]);
    
    const result3 = await handler.handleAllPopups(page3, 'TEST-3');
    console.log(`结果: ${result3 ? '✅ 成功' : '❌ 失败'}\n`);
    assert.equal(result3, true, '多个弹窗场景至少应成功处理一个弹窗');
    assert.ok(page3.closedPopups.length >= 1, '多个弹窗场景应该关闭至少一个弹窗');

    // 测试4: 无弹窗页面
    console.log('📋 测试4: 无弹窗页面');
    const page4 = new MockPage([]);
    
    const result4 = await handler.handleAllPopups(page4, 'TEST-4');
    console.log(`结果: ${result4 ? '❌ 意外成功' : '✅ 正确返回false'}\n`);
    assert.equal(result4, false, '无弹窗页面不应返回成功');

    // 测试5: 配置禁用
    console.log('📋 测试5: 配置禁用弹窗处理');
    handler.setConfig({
        popupHandling: {
            enabled: false
        }
    });
    
    const page5 = new MockPage([
        { id: 'ref3', type: 'Referral Popup', selector: '[data-testid="referral-popup"]' }
    ]);
    
    const result5 = await handler.handleAllPopups(page5, 'TEST-5');
    console.log(`结果: ${result5 ? '❌ 意外处理' : '✅ 正确跳过'}\n`);
    assert.equal(result5, false, '配置禁用时不应处理弹窗');
    assert.deepEqual(page5.closedPopups, [], '配置禁用时不应关闭任何弹窗');

    // 测试6: hasAnyPopup 方法
    console.log('📋 测试6: 弹窗检测方法');
    const page6 = new MockPage([
        { id: 'modal2', type: 'Generic Modal', selector: '.modal[style*="display: block"]' }
    ]);
    
    const hasPopup = await handler.hasAnyPopup(page6);
    console.log(`结果: ${hasPopup ? '✅ 正确检测到弹窗' : '❌ 未检测到弹窗'}\n`);
    assert.equal(hasPopup, true, 'hasAnyPopup 应检测到弹窗');

    console.log('🎉 弹窗处理系统测试完成！');
}

// 运行测试
if (require.main === module) {
    testPopupHandling().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { testPopupHandling };
