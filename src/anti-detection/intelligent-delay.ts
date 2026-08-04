/**
 * 智能延迟系统
 * 基于真实用户行为模式的非模式化延迟生成
 *
 * 核心是一次对数正态(log-normal)抽样：人类两次操作的间隔本就是右偏、长尾的分布——大多数较短、
 * 偶有很长的停顿。相比此前“分段均匀 + 多模式加权”的写法，对数正态没有可被检测的区间硬边界。
 * 抽样之后再叠加：生活中断、时间感知、会话疲劳，并对单次延迟封顶。
 */
export class IntelligentDelaySystem {
    // 单次延迟上限，避免生活中断与多个倍率叠加后出现 >1 小时的极端等待
    private static readonly MAX_SEARCH_DELAY_MS = 10 * 60_000
    private lastActivityTime: number = 0
    private sessionStartTime: number = Date.now()
    private consecutiveFailures: number = 0

    /**
     * 计算搜索延迟
     */
    calculateSearchDelay(searchIndex: number, isMobile: boolean, hasFailures: boolean = false): number {
        const now = Date.now()

        // 如果有失败，增加谨慎度；否则缓慢回落
        if (hasFailures) {
            this.consecutiveFailures++
        } else {
            this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1)
        }

        // 基础延迟范围（基于真实用户行为统计）
        const baseRanges = {
            mobile: { min: 18000, max: 95000 },    // 18秒-95秒
            desktop: { min: 25000, max: 140000 }   // 25秒-140秒
        }

        const range = isMobile ? baseRanges.mobile : baseRanges.desktop

        // 对数正态抽样（右偏长尾，无区间硬边界）
        let delay = this.logNormalDelay(range.min, range.max)

        // 连续失败时更谨慎（拉长间隔）
        if (this.consecutiveFailures > 0) {
            const cautionMultiplier = 1.3 + (this.consecutiveFailures * 0.2)
            delay *= cautionMultiplier
        }

        // 添加生活中断模拟
        delay = this.addLifeInterruptions(delay)

        // 时间感知调整
        delay = this.applyTimeAwareAdjustment(delay)

        // 会话疲劳效应
        delay = this.applySessionFatigue(delay, searchIndex)

        // 封顶单次延迟，避免极端等待拖垮运行时间预算
        delay = Math.min(delay, IntelligentDelaySystem.MAX_SEARCH_DELAY_MS)

        this.lastActivityTime = now

        return Math.floor(delay)
    }

    /**
     * 对数正态延迟：中位数约落在区间的 30% 处，向上有长尾，向下不低于 min。
     * 用 Box-Muller 生成标准正态，再取指数得到右偏分布。
     */
    private logNormalDelay(min: number, max: number): number {
        const span = max - min
        const u1 = Math.max(1e-9, Math.random())
        const u2 = Math.random()
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        const sigma = 0.6
        const sample = Math.exp(sigma * z) // 中位数为 1，典型范围约 [0.4, 2.5]，偶有更大值
        const scaled = min + span * 0.3 * sample
        return Math.max(min, Math.min(max, scaled))
    }

    /**
     * 添加生活中断模拟
     */
    private addLifeInterruptions(baseDelay: number): number {
        const random = Math.random()

        // 5%概率的长时间中断（接电话、上厕所、吃东西等）
        if (random < 0.05) {
            const interruptionTypes = [
                { min: 120000, max: 300000 },  // 2-5分钟：短暂离开
                { min: 300000, max: 900000 },  // 5-15分钟：接电话
                { min: 600000, max: 1800000 }  // 10-30分钟：吃饭/休息
            ]
            const interruption = interruptionTypes[Math.floor(Math.random() * interruptionTypes.length)]
            const interruptionTime = (interruption?.min || 100) + Math.random() * ((interruption?.max || 500) - (interruption?.min || 100))
            return baseDelay + interruptionTime
        }

        // 15%概率的短时间中断（查看通知、回复消息等）
        if (random < 0.20) {
            const shortInterruption = 8000 + Math.random() * 25000 // 8-33秒
            return baseDelay + shortInterruption
        }

        // 10%概率的微中断（思考、阅读等）
        if (random < 0.30) {
            const microInterruption = 3000 + Math.random() * 8000 // 3-11秒
            return baseDelay + microInterruption
        }

        return baseDelay
    }

    /**
     * 时间感知调整
     */
    private applyTimeAwareAdjustment(delay: number): number {
        const hour = new Date().getHours()
        const dayOfWeek = new Date().getDay()

        let multiplier = 1.0

        // 深夜时间（1-6点）- 用户更慢更谨慎
        if (hour >= 1 && hour <= 6) {
            multiplier *= 1.6 + Math.random() * 0.4
        }
        // 早晨忙碌时间（7-9点）- 用户可能更快
        else if (hour >= 7 && hour <= 9) {
            multiplier *= 0.7 + Math.random() * 0.3
        }
        // 工作时间（9-17点）- 用户可能分心
        else if (hour >= 9 && hour <= 17) {
            multiplier *= 0.8 + Math.random() * 0.4
        }
        // 晚上黄金时间（19-23点）- 正常使用
        else if (hour >= 19 && hour <= 23) {
            multiplier *= 0.9 + Math.random() * 0.3
        }

        // 周末调整
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            multiplier *= 1.1 + Math.random() * 0.2 // 周末更悠闲
        }

        return delay * multiplier
    }

    /**
     * 会话疲劳效应
     */
    private applySessionFatigue(delay: number, searchIndex: number): number {
        const sessionDuration = Date.now() - this.sessionStartTime
        const sessionMinutes = sessionDuration / 60000

        // 会话时间越长，用户越疲劳
        let fatigueMultiplier = 1.0

        if (sessionMinutes > 10) {
            fatigueMultiplier += (sessionMinutes - 10) * 0.02 // 每分钟增加2%延迟
        }

        // 搜索次数疲劳
        if (searchIndex > 10) {
            fatigueMultiplier += (searchIndex - 10) * 0.01 // 每次搜索增加1%延迟
        }

        return delay * Math.min(fatigueMultiplier, 2.0) // 最多2倍延迟
    }

    /**
     * 重置会话
     */
    resetSession(): void {
        this.sessionStartTime = Date.now()
        this.consecutiveFailures = 0
    }

    /**
     * 获取当前状态
     */
    getStatus(): { consecutiveFailures: number; sessionDuration: number; lastActivityTime: number } {
        return {
            consecutiveFailures: this.consecutiveFailures,
            sessionDuration: Date.now() - this.sessionStartTime,
            lastActivityTime: this.lastActivityTime
        }
    }
}
