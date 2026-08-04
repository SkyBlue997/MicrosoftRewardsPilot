import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'
import { HumanBehaviorSimulator } from '../../src/anti-detection/human-behavior'


export class Poll extends Workers {
    private humanBehavior: HumanBehaviorSimulator

    constructor(bot: any) {
        super(bot)
        this.humanBehavior = new HumanBehaviorSimulator()
    }

    async doPoll(page: Page) {
        this.bot.log(this.bot.isMobile, 'POLL', 'Trying to complete poll')

        try {
            const buttonId = `#btoption${Math.floor(this.bot.utils.randomNumber(0, 1))}`

            await page.waitForSelector(buttonId, { state: 'visible', timeout: 10000 }).catch(() => { }) // We're gonna click regardless or not

            // 🎭 使用人类行为模拟
            await this.humanBehavior.simulateThinking()
            await this.bot.utils.wait(2000)

            // 人类化点击
            const element = await page.$(buttonId)
            if (element) {
                const box = await element.boundingBox()
                if (box) {
                    await this.humanBehavior.humanClick(page, box.x + box.width/2, box.y + box.height/2)
                } else {
                    await page.click(buttonId)
                }
            } else {
                await page.click(buttonId)
            }

            await this.bot.utils.wait(4000)
            await page.close()

            this.bot.log(this.bot.isMobile, 'POLL', 'Completed the poll successfully')
        } catch (error) {
            await page.close()
            this.bot.log(this.bot.isMobile, 'POLL', 'An error occurred:' + error, 'error')
        }
    }

}