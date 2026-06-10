import { Page } from 'rebrowser-playwright'

/**
 * 增强的人类行为模拟系统
 * 提供更真实的鼠标移动、键盘输入和交互模式
 */
export class HumanBehaviorSimulator {
    private mousePosition = { x: 0, y: 0 }
    private typingSpeed = 150 // 基础打字速度（毫秒）
    private errorRate = 0.02 // 打字错误率
    
    /**
     * 人类化鼠标移动
     */
    async humanMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
        // 以上次记录的位置为起点：实时页面上 window.mouseX/Y 永远是 0，addInitScript 也只会无效累积
        const currentPos = this.mousePosition
        
        // 生成贝塞尔曲线路径
        const path = this.generateBezierPath(currentPos, { x: targetX, y: targetY })
        
        for (let i = 0; i < path.length; i++) {
            const point = path[i]
            await page.mouse.move(point?.x || 0, point?.y || 0)
            
            // 真实的鼠标移动速度变化
            const speed = this.calculateMouseSpeed(i, path.length)
            await page.waitForTimeout(speed)
        }
        
        // 更新鼠标位置追踪
        this.mousePosition = { x: targetX, y: targetY }
    }
    
    /**
     * 生成贝塞尔曲线路径
     */
    private generateBezierPath(start: { x: number; y: number }, end: { x: number; y: number }): Array<{ x: number; y: number }> {
        const distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2))
        const steps = Math.max(10, Math.min(50, Math.floor(distance / 10)))
        
        // 生成控制点，添加自然的曲线
        const cp1x = start.x + (end.x - start.x) * 0.25 + (Math.random() - 0.5) * 100
        const cp1y = start.y + (end.y - start.y) * 0.25 + (Math.random() - 0.5) * 100
        const cp2x = start.x + (end.x - start.x) * 0.75 + (Math.random() - 0.5) * 100
        const cp2y = start.y + (end.y - start.y) * 0.75 + (Math.random() - 0.5) * 100
        
        const path: Array<{ x: number; y: number }> = []
        
        for (let i = 0; i <= steps; i++) {
            const t = i / steps
            const x = Math.pow(1 - t, 3) * start.x + 
                     3 * Math.pow(1 - t, 2) * t * cp1x + 
                     3 * (1 - t) * Math.pow(t, 2) * cp2x + 
                     Math.pow(t, 3) * end.x
            const y = Math.pow(1 - t, 3) * start.y + 
                     3 * Math.pow(1 - t, 2) * t * cp1y + 
                     3 * (1 - t) * Math.pow(t, 2) * cp2y + 
                     Math.pow(t, 3) * end.y
            
            // 添加微小的随机抖动
            path.push({
                x: x + (Math.random() - 0.5) * 2,
                y: y + (Math.random() - 0.5) * 2
            })
        }
        
        return path
    }
    
    /**
     * 计算鼠标移动速度
     */
    private calculateMouseSpeed(step: number, totalSteps: number): number {
        // 模拟真实的鼠标移动：开始慢，中间快，结束慢
        const progress = step / totalSteps
        let speedMultiplier: number
        
        if (progress < 0.2) {
            // 开始阶段：加速
            speedMultiplier = 0.5 + progress * 2.5
        } else if (progress < 0.8) {
            // 中间阶段：匀速
            speedMultiplier = 1.0 + Math.sin(progress * Math.PI) * 0.3
        } else {
            // 结束阶段：减速
            speedMultiplier = 1.0 - (progress - 0.8) * 2.5
        }
        
        const baseDelay = 16 // 60fps基础延迟
        return Math.max(8, Math.floor(baseDelay * speedMultiplier + Math.random() * 8))
    }
    
    /**
     * 人类化点击
     */
    async humanClick(page: Page, x: number, y: number): Promise<void> {
        // 先移动到目标位置
        await this.humanMouseMove(page, x, y)
        
        // 短暂停顿（瞄准时间）
        await page.waitForTimeout(50 + Math.random() * 100)
        
        // 模拟按下和释放的时间间隔
        await page.mouse.down()
        await page.waitForTimeout(80 + Math.random() * 40) // 80-120ms的点击持续时间
        await page.mouse.up()
        
        // 点击后的短暂停顿
        await page.waitForTimeout(100 + Math.random() * 200)
    }
    
    /**
     * 人类化打字
     */
    async humanType(page: Page, text: string, selector?: string): Promise<void> {
        if (selector) {
            await page.click(selector)
            await page.waitForTimeout(200 + Math.random() * 300)
        }
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i]

            // 确保字符存在
            if (!char) continue

            // 模拟打字错误
            if (Math.random() < this.errorRate && i > 0) {
                await this.simulateTypingError(page, char)
            }

            // 打字
            await page.keyboard.type(char)

            // 变化的打字速度
            const delay = this.getTypingDelay(char, i, text.length)
            await page.waitForTimeout(delay)
        }
    }
    
    /**
     * 模拟打字错误
     */
    private async simulateTypingError(page: Page, correctChar: string): Promise<void> {
        // 常见的打字错误模式
        const errorTypes = [
            () => this.adjacentKeyError(correctChar),
            () => this.doubleKeyError(correctChar)
        ]
        
        const errorType = errorTypes[Math.floor(Math.random() * errorTypes.length)]
        const wrongChar = errorType ? errorType() : 'x'
        
        if (wrongChar) {
            // 打错字
            await page.keyboard.type(wrongChar)
            await page.waitForTimeout(100 + Math.random() * 200)
            
            // 意识到错误，删除
            await page.keyboard.press('Backspace')
            await page.waitForTimeout(150 + Math.random() * 100)
        }
    }
    
    /**
     * 相邻键错误
     */
    private adjacentKeyError(char: string): string {
        const adjacentKeys: Record<string, string[]> = {
            'a': ['s', 'q', 'w'],
            's': ['a', 'd', 'w', 'e'],
            'd': ['s', 'f', 'e', 'r'],
            'f': ['d', 'g', 'r', 't'],
            'g': ['f', 'h', 't', 'y'],
            'h': ['g', 'j', 'y', 'u'],
            'j': ['h', 'k', 'u', 'i'],
            'k': ['j', 'l', 'i', 'o'],
            'l': ['k', 'o', 'p'],
            'q': ['w', 'a'],
            'w': ['q', 'e', 'a', 's'],
            'e': ['w', 'r', 's', 'd'],
            'r': ['e', 't', 'd', 'f'],
            't': ['r', 'y', 'f', 'g'],
            'y': ['t', 'u', 'g', 'h'],
            'u': ['y', 'i', 'h', 'j'],
            'i': ['u', 'o', 'j', 'k'],
            'o': ['i', 'p', 'k', 'l'],
            'p': ['o', 'l']
        }
        
        const adjacent = adjacentKeys[char.toLowerCase()]
        return adjacent ? (adjacent[Math.floor(Math.random() * adjacent.length)] || '') : ''
    }
    
    /**
     * 双击错误
     */
    private doubleKeyError(char: string): string {
        return char + char
    }
    
    /**
     * 获取打字延迟
     */
    private getTypingDelay(char: string, position: number, totalLength: number): number {
        let baseDelay = this.typingSpeed
        
        // 字符类型影响速度
        if (char === ' ') {
            baseDelay *= 0.8 // 空格稍快
        } else if (/[A-Z]/.test(char)) {
            baseDelay *= 1.2 // 大写字母稍慢
        } else if (/[0-9]/.test(char)) {
            baseDelay *= 1.1 // 数字稍慢
        } else if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(char)) {
            baseDelay *= 1.3 // 特殊字符更慢
        }
        
        // 位置影响：开始和结束稍慢
        if (position < 3 || position > totalLength - 3) {
            baseDelay *= 1.1
        }
        
        // 添加随机变化
        const randomFactor = 0.7 + Math.random() * 0.6 // 0.7-1.3倍
        
        return Math.floor(baseDelay * randomFactor)
    }
    
    /**
     * 模拟页面滚动
     */
    async humanScroll(page: Page, direction: 'up' | 'down' = 'down', distance?: number): Promise<void> {
        const scrollDistance = distance || (200 + Math.random() * 400)
        const steps = 5 + Math.floor(Math.random() * 10)
        const stepDistance = scrollDistance / steps
        
        for (let i = 0; i < steps; i++) {
            const delta = direction === 'down' ? stepDistance : -stepDistance
            await page.mouse.wheel(0, delta)
            
            // 滚动间的自然停顿
            await page.waitForTimeout(50 + Math.random() * 100)
        }
        
        // 滚动后的停顿
        await page.waitForTimeout(300 + Math.random() * 700)
    }
    
    /**
     * 模拟阅读行为
     */
    async simulateReading(page: Page, duration?: number): Promise<void> {
        const readingTime = duration || (2000 + Math.random() * 8000) // 2-10秒
        const scrollCount = 1 + Math.floor(Math.random() * 3)
        
        for (let i = 0; i < scrollCount; i++) {
            await page.waitForTimeout(readingTime / scrollCount)
            
            // 偶尔滚动查看更多内容
            if (Math.random() < 0.7) {
                await this.humanScroll(page, 'down', 100 + Math.random() * 200)
            }
        }
    }
    
    /**
     * 模拟思考停顿
     */
    async simulateThinking(): Promise<void> {
        // 不同类型的思考停顿
        const thinkingPatterns = [
            () => 500 + Math.random() * 1500,  // 短暂思考
            () => 1500 + Math.random() * 3000, // 中等思考
            () => 3000 + Math.random() * 5000  // 深度思考
        ]
        
        const pattern = thinkingPatterns[Math.floor(Math.random() * thinkingPatterns.length)]
        const thinkingTime = pattern ? pattern() : 1000
        
        await new Promise(resolve => setTimeout(resolve, thinkingTime))
    }
    
    /**
     * 模拟随机页面交互
     */
    async randomPageInteraction(page: Page): Promise<void> {
        const interactions = [
            async () => {
                // 随机滚动
                await this.humanScroll(page, Math.random() > 0.5 ? 'down' : 'up')
            },
            async () => {
                // 随机鼠标移动
                const viewport = page.viewportSize()
                if (viewport) {
                    const x = Math.random() * viewport.width
                    const y = Math.random() * viewport.height
                    await this.humanMouseMove(page, x, y)
                }
            },
            async () => {
                // 模拟阅读
                await this.simulateReading(page, 1000 + Math.random() * 3000)
            }
        ]
        
        // 30%概率进行随机交互
        if (Math.random() < 0.3) {
            const interaction = interactions[Math.floor(Math.random() * interactions.length)]
            if (interaction) await interaction()
        }
    }
    
    /**
     * 设置打字速度
     */
    setTypingSpeed(speed: number): void {
        this.typingSpeed = Math.max(50, Math.min(500, speed))
    }
    
    /**
     * 设置错误率
     */
    setErrorRate(rate: number): void {
        this.errorRate = Math.max(0, Math.min(0.1, rate))
    }

    /**
     * 获取当前鼠标位置
     */
    getCurrentMousePosition(): { x: number; y: number } {
        return { ...this.mousePosition }
    }
}
