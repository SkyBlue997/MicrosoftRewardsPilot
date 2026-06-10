import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'
import { HumanBehaviorSimulator } from '../../src/anti-detection/human-behavior'


export class Quiz extends Workers {
    private humanBehavior: HumanBehaviorSimulator

    constructor(bot: any) {
        super(bot)
        this.humanBehavior = new HumanBehaviorSimulator()
    }

    async doQuiz(page: Page) {
        this.bot.log(this.bot.isMobile, 'QUIZ', 'Trying to complete quiz')

        try {
            // 首先检查页面是否已关闭
            if (page.isClosed()) {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Page has been closed, cannot complete quiz', 'warn')
                return
            }

            // Check if the quiz has been started or not - try multiple start button selectors
            const startButtonSelectors = [
                '#rqStartQuiz',
                'button[data-testid="quiz-start"]',
                'button[class*="quiz-start"]',
                'button:has-text("Start")',
                'button:has-text("开始")',
                '.quiz-start-btn',
                'input[type="submit"][value*="Start"]'
            ]
            
            let quizStarted = false
            for (const selector of startButtonSelectors) {
                try {
                    const startButton = await page.waitForSelector(selector, { state: 'visible', timeout: 1000 })
                    if (startButton) {
                        this.bot.log(this.bot.isMobile, 'QUIZ', `Found start button with selector: ${selector}`)

                        // 🎭 使用人类行为模拟点击
                        await this.humanBehavior.simulateThinking()
                        const box = await startButton.boundingBox()
                        if (box) {
                            await this.humanBehavior.humanClick(page, box.x + box.width/2, box.y + box.height/2)
                        } else {
                            await startButton.click()
                        }

                        await this.bot.utils.wait(3000) // 等待页面加载
                        quizStarted = true
                        break
                    }
                } catch {
                    continue // 尝试下一个选择器
                }
            }
            
            if (!quizStarted) {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'No start button found, quiz may have already been started')
            }

            await this.bot.utils.wait(2000)

            let quizData
            try {
                quizData = await this.bot.browser.func.getQuizData(page)
            } catch (error) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to extract quiz data: ${error}`, 'error')
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Skipping quiz - data extraction failed', 'warn')
                await page.close()
                return
            }

            if (!quizData || !quizData.maxQuestions) {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Invalid quiz data structure, skipping', 'warn')
                await page.close()
                return
            }

            const questionsRemaining = quizData.maxQuestions - (quizData.CorrectlyAnsweredQuestionCount || 0) // Amount of questions remaining

            // All questions
            for (let question = 0; question < questionsRemaining; question++) {

                if (quizData.numberOfOptions === 8) {
                    const answers: string[] = []

                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        try {
                            // 先等待元素存在（不管是否可见）
                            await page.waitForSelector(`#rqAnswerOption${i}`, { state: 'attached', timeout: 5000 })
                            
                            // 尝试使元素可见（如果是隐藏的）
                            await page.evaluate((selector) => {
                                const element = document.querySelector(selector)
                                if (element) {
                                    (element as HTMLElement).style.display = 'block';
                                    (element as HTMLElement).style.visibility = 'visible'
                                }
                            }, `#rqAnswerOption${i}`)
                            
                            // 等待一下让样式生效
                            await this.bot.utils.wait(100)
                            
                            const answerElement = await page.$(`#rqAnswerOption${i}`)
                            const answerAttribute = await answerElement?.getAttribute('iscorrectoption')

                            if (answerAttribute && answerAttribute.toLowerCase() === 'true') {
                                answers.push(`#rqAnswerOption${i}`)
                            }
                        } catch (error) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to check answer option ${i}: ${error}`, 'warn')
                        }
                    }

                    // Click the answers
                    for (const answer of answers) {
                        try {
                            // 使用force click来点击可能隐藏的元素
                            await page.click(answer, { force: true })

                            const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                            if (!refreshSuccess) {
                                await page.close()
                                this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error')
                                return
                            }
                        } catch (error) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to click answer ${answer}: ${error}`, 'warn')
                        }
                    }

                } else {
                    // Other type quiz, lightspeed (2, 3, 4 options)
                    quizData = await this.bot.browser.func.getQuizData(page) // Refresh Quiz Data
                    const correctOption = quizData.correctAnswer

                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        try {
                            // 先等待元素存在（不管是否可见）
                            await page.waitForSelector(`#rqAnswerOption${i}`, { state: 'attached', timeout: 5000 })
                            
                            // 尝试使元素可见（如果是隐藏的）
                            await page.evaluate((selector) => {
                                const element = document.querySelector(selector)
                                if (element) {
                                    (element as HTMLElement).style.display = 'block';
                                    (element as HTMLElement).style.visibility = 'visible'
                                }
                            }, `#rqAnswerOption${i}`)
                            
                            await this.bot.utils.wait(100)
                            
                            const answerElement = await page.$(`#rqAnswerOption${i}`)
                            const dataOption = await answerElement?.getAttribute('data-option')

                            if (dataOption === correctOption) {
                                // 使用force click来点击可能隐藏的元素
                                await page.click(`#rqAnswerOption${i}`, { force: true })

                                const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                                if (!refreshSuccess) {
                                    await page.close()
                                    this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error')
                                    return
                                }
                                break // 找到正确答案后退出循环
                            }
                        } catch (error) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to check answer option ${i}: ${error}`, 'warn')
                        }
                    }
                    await this.bot.utils.wait(2000)
                }
            }

            // Done with
            await this.bot.utils.wait(2000)
            await page.close()

            this.bot.log(this.bot.isMobile, 'QUIZ', 'Completed the quiz successfully')
        } catch (error) {
            await page.close()
            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred:' + error, 'error')
        }
    }

}