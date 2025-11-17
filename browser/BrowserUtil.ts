import { Page } from 'rebrowser-playwright'
import { load } from 'cheerio'

import { MicrosoftRewardsBot } from '../src/index'
import { PopupHandler } from '../src/anti-detection/popup-handler'


export default class BrowserUtil {
    private bot: MicrosoftRewardsBot
    private popupHandler: PopupHandler

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.popupHandler = PopupHandler.getInstance()
        // 传递配置给弹窗处理器
        this.popupHandler.setConfig(bot.config)
    }

    async tryDismissAllMessages(page: Page): Promise<void> {
        // 首先处理Microsoft Rewards弹窗
        try {
            const handledPopups = await this.popupHandler.handleAllPopups(page, 'DISMISS-MESSAGES')
            if (handledPopups) {
                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', 'Handled Microsoft Rewards popups')
                await page.waitForTimeout(1000) // 等待弹窗关闭完成
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', `Popup handling error: ${error}`, 'warn')
        }

        // 然后处理传统的cookie和同意按钮
        const buttons = [
            { selector: '#acceptButton', label: 'AcceptButton' },
            { selector: '.ext-secondary.ext-button', label: '"Skip for now" Button' },
            { selector: '#iLandingViewAction', label: 'iLandingViewAction' },
            { selector: '#iShowSkip', label: 'iShowSkip' },
            { selector: '#iNext', label: 'iNext' },
            { selector: '#iLooksGood', label: 'iLooksGood' },
            { selector: '#idSIButton9', label: 'idSIButton9' },
            { selector: '.ms-Button.ms-Button--primary', label: 'Primary Button' },
            { selector: '.c-glyph.glyph-cancel', label: 'Mobile Welcome Button' },
            { selector: '.maybe-later', label: 'Mobile Rewards App Banner' },
            { selector: '//div[@id="cookieConsentContainer"]//button[contains(text(), "Accept")]', label: 'Accept Cookie Consent Container', isXPath: true },
            { selector: '#bnp_btn_accept', label: 'Bing Cookie Banner' },
            { selector: '#reward_pivot_earn', label: 'Reward Coupon Accept' }
        ]

        for (const button of buttons) {
            try {
                const element = button.isXPath ? page.locator(`xpath=${button.selector}`) : page.locator(button.selector)
                await element.first().click({ timeout: 500 })
                await page.waitForTimeout(500)

                this.bot.log(this.bot.isMobile, 'DISMISS-ALL-MESSAGES', `Dismissed: ${button.label}`)

            } catch (error) {
                // Silent fail
            }
        }
    }

    /**
     * 专门处理Microsoft Rewards弹窗的方法
     */
    async handleRewardsPopups(page: Page): Promise<boolean> {
        try {
            const handledPopups = await this.popupHandler.handleAllPopups(page, 'REWARDS-POPUP')
            if (handledPopups) {
                this.bot.log(this.bot.isMobile, 'REWARDS-POPUP', 'Successfully handled Microsoft Rewards popups')
                await page.waitForTimeout(1500) // 等待弹窗关闭和页面稳定
                return true
            }
            return false
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'REWARDS-POPUP', `Error handling popups: ${error}`, 'warn')
            return false
        }
    }

    /**
     * 检查页面是否有弹窗
     */
    async hasPopups(page: Page): Promise<boolean> {
        try {
            return await this.popupHandler.hasAnyPopup(page)
        } catch (error) {
            return false
        }
    }

    /**
     * 清理弹窗处理记录（用于新会话）
     */
    clearPopupHistory(): void {
        this.popupHandler.clearHandledPopups()
    }

    async getLatestTab(page: Page): Promise<Page> {
        try {
            await this.bot.utils.wait(1000)

            const browser = page.context()
            
            if (!browser) {
                throw new Error('Browser context is null or undefined')
            }
            
            const pages = browser.pages()
            
            if (!pages || pages.length === 0) {
                throw new Error('No pages found in browser context')
            }
            
            const newTab = pages[pages.length - 1]

            if (newTab) {
                if (newTab.isClosed()) {
                    throw new Error('Latest tab is already closed')
                }
                
                try {
                    await newTab.evaluate(() => true, { timeout: 2000 })
                } catch (evalError) {
                    throw new Error('Latest tab is not responsive')
                }
                
                return newTab
            }

            throw new Error('Unable to get latest tab')
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.log(this.bot.isMobile, 'GET-NEW-TAB', `An error occurred: ${errorMessage}`, 'error')
            throw new Error(`An error occurred: ${errorMessage}`)
        }
    }

    async getTabs(page: Page) {
        try {
            const browser = page.context()
            const pages = browser.pages()

            const homeTab = pages[1]
            let homeTabURL: URL

            if (!homeTab) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'Home tab could not be found!', 'error')
                throw new Error('Home tab could not be found!')

            } else {
                homeTabURL = new URL(homeTab.url())

                if (homeTabURL.hostname !== 'rewards.bing.com') {
                    this.bot.log(this.bot.isMobile, 'GET-TABS', 'Reward page hostname is invalid: ' + homeTabURL.host, 'error')
                    throw new Error('Reward page hostname is invalid: ' + homeTabURL.host)
                }
            }

            const workerTab = pages[2]
            if (!workerTab) {
                this.bot.log(this.bot.isMobile, 'GET-TABS', 'Worker tab could not be found!', 'error')
                throw new Error('Worker tab could not be found!')
            }

            return {
                homeTab: homeTab,
                workerTab: workerTab
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-TABS', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }

    async reloadBadPage(page: Page): Promise<void> {
        try {
            const html = await page.content().catch(() => '')
            const $ = load(html)

            const isNetworkError = $('body.neterror').length

            if (isNetworkError) {
                this.bot.log(this.bot.isMobile, 'RELOAD-BAD-PAGE', 'Bad page detected, reloading!')
                await page.reload()
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'RELOAD-BAD-PAGE', 'An error occurred:' + error, 'error')
            throw new Error('An error occurred:' + error)
        }
    }

}