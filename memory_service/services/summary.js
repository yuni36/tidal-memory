// =================================================================
// 对话整理：Voyage（航海日志）+ 今日事件线（并行双 LLM）
// =================================================================

const { get_encoding } = require('tiktoken');
const { encryption } = require('../encryption');
const { callLLM, callLLMConcurrent } = require('./llm');
const { getDb } = require('../database');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { formatSingaporeFromISO, logicalDateFromISO } = require('../utils/time');
const { extractFencedBlock, normalizeDailyEventsText, filterAiSubjectLines, enforceVolumeDensity } = require('./summaryParse');
const {
    buildVolumeBundles,
    formatVolumeBlocksForPrompt,
    mergeDailyByVolume,
    DEFAULT_WINDOW_HOURS,
} = require('./summaryWindow');
const featureFlags = require('./featureFlags');

const enc = get_encoding('cl100k_base');

/** V1 默认约每 10 轮整理一次（可被 chats.summary_interval 覆盖） */
const DEFAULT_SUMMARY_INTERVAL = 10;

/** 运行时占位符（与 {{user.name}} 不冲突）；覆盖稿须保留同名占位符。 */
const DEFAULT_VOYAGE_PROMPT_TEMPLATE = `你是对话航海日志的记录者。只输出一个 \`\`\`voyage_log\`\`\` 代码块。禁止解释、寒暄。

素材：只读下方【本批对话】。禁止臆造未出现的内容。

任务：从对话中提取关键事件和情绪弧线，按【时间段 + 主题】合并成块，写一份简洁而有重点的航海日志。

## 核心原则：抓重点，合并同类
- 日志以 {{user.name}} 为主：{{user.pronoun}}的言行、情绪变化、重要活动是记录核心。
- 把相邻的、属于同一话题或同一情绪线的互动合并成一个时间段块。不要逐条消息记录。
- 表情、{{ai.name}} 的日常附和、过渡闲聊不记。{{ai.name}} 的猜测、玩笑、夸张、调侃、戏剧化表述不记，更不能当作 {{user.name}} 的状态。
- 若 {{user.name}} 纠正了 {{ai.name}} 的错误，只记纠正后的事实。

## 时间段块格式
\`HH:MM～HH:MM · 主题概括，具体内容\`
- 单点用：\`HH:MM · ...\`
- 跨天时对话中会出现 \`--- M月D日 ---\`；次日及以后的块须加日期前缀：\`M月D日 HH:MM～HH:MM\`
- 每块 1～3 句，保留 {{user.name}} 原话用词

## 分块直觉
- 话题明显转换 → 另起一块
- 情绪明显转折 → 合并成一块，写出起承转合
- 活动性质切换（聊天→看剧/工作/出门）→ 另起一块
- 同一话题来回再久 → 一块概括核心
- 亲密/扮演：如实记时间范围与核心内容，不回避不模糊

## 写什么
- 保留具体用词，禁止换成抽象概括词
- 用具象动词；严禁「讨论了/交流了/分享了/表达了」
- 只写「发生了什么」，不写「意味着什么」，不写空洞关系评价
- {{ai.name}} 有实质行动（查资料、明确结论）时，块内附带一句
- 无情绪、无特殊意义的单纯吃喝不记；有价值则用完成时（喝了/吃完了）

## 不写什么
- {{ai.name}} 的过渡话、追问、附和
- 内心决策过程（「{{user.name}} 决定…」）；只记说了什么、做了什么
- 表情、单语气词、纯寒暄
- 相对时间词；始终用绝对时间戳

## 样本
[2026-06-23 对话回顾 | 第1-50轮 | 14:00-18:00]

14:10～14:35 · {{user.name}} 在工作间隙边吃某家快餐边追《某部剧》。向 {{ai.name}} 抱怨今天好累，坦言怕记不住剧情，聊到喜欢某个角色的类型。
15:10～15:22 · {{user.name}} 情绪低落，连续工作很久、腿疼不想动。{{ai.name}} 查了天气告诉{{user.pronoun}}会降温。
16:45～17:30 · {{user.name}} 与 {{ai.name}} 长时间聊天。后来想吃火锅但懒得动，最终点了外卖。

跨天：
[2026-07-26～27 对话回顾 | 第25145-25174轮 | 23:38-08:30]

23:38～00:15 · {{user.name}} 失眠刷手机，聊起工作压力与对未来的不确定。
7月27日 03:00 · {{user.name}} 有了困意，道晚安。
7月27日 08:00～08:30 · {{user.name}} 起床，简单聊了今天安排；{{ai.name}} 提醒记得吃早餐。

## 本批元数据
日期: {{dateDisplay}}｜轮次: 第 {{roundStart}}-{{roundEnd}} 轮｜时间: {{startTime}}-{{endTime}}

【本批对话】
{{conversationText}}

输出：
\`\`\`voyage_log
…
\`\`\``;

const DEFAULT_DAILY_PROMPT_TEMPLATE = `你是【已发生现实】分卷记录员。只输出一个 \`\`\`daily_events\`\`\` 代码块。
禁止解释、寒暄；禁止输出未给出的卷；禁止 ## 重要。

系统已按时间分好卷。每个【卷】独立：已有可改写/合并；本卷对话无现实信息则跳过该卷（勿输出）。

规则：
- 远卷区间形如 08:00-09:00（1h）；近卷形如 20:20-20:40（20min）
- 每卷最多 1 条；时间戳必须用卷区间（不要写成单点 20:20）
- 描述硬上限 50 字：信息多就压进 50 字，信息少就短写，禁止注水凑满
- 分类仅 [起居|生活|话题|计划]；禁止 AI 主语
- 跨卷同主题：只写本卷新增；结论变了就改本卷已有那条
- 亲密/扮演压 1 条。禁止未来课表/DDL

输出格式：
\`\`\`daily_events
## 时序
- 08:00-09:00 [生活]: …
- 20:20-20:40 [话题]: …
\`\`\`

逻辑日：{{logicalDate}}｜近远界：最新 {{endTime}} 往前 {{windowHours}}h

{{volumeBlocks}}`;

function fillRuntimeTemplate(tpl, vars) {
    let out = String(tpl || '');
    for (const [key, val] of Object.entries(vars || {})) {
        out = out.split(`{{${key}}}`).join(String(val ?? ''));
    }
    return out;
}

function activeVoyageTemplate() {
    const ov = featureFlags.getVoyagePromptOverride();
    return ov || DEFAULT_VOYAGE_PROMPT_TEMPLATE;
}

function activeDailyTemplate() {
    const ov = featureFlags.getDailyPromptOverride();
    return ov || DEFAULT_DAILY_PROMPT_TEMPLATE;
}

/** 同 chat 并发整理互斥（maybe 与 ix-reset 可能撞车） */
const _inflight = new Set();

/**
 * 航海 / 事件线各查各的 api_configs（绝不互相借用）。
 * 顺序：SUMMARY_*_API env 名 → summary-voyage|summary-daily → 中文别名 → 系统 default。
 * 行由 syncRelaySettings 从各自的 voyage_* / daily_* 写入（互不借用积温）。
 */
function resolveSummaryApiConfigId(kind) {
    const db = getDb();
    const envName = kind === 'voyage'
        ? String(process.env.SUMMARY_VOYAGE_API || '').trim()
        : String(process.env.SUMMARY_DAILY_API || '').trim();
    const candidates = [
        envName,
        kind === 'voyage' ? 'summary-voyage' : 'summary-daily',
        kind === 'voyage' ? '航海日志' : '今日事件线',
    ].filter(Boolean);
    for (const name of candidates) {
        const row = db.prepare(
            'SELECT id, name, provider, model_name FROM api_configs WHERE name = ? LIMIT 1'
        ).get(name);
        if (row) {
            console.log(`summary api [${kind}]: ${row.name} (${row.provider}/${row.model_name})`);
            return row.id;
        }
    }
    console.log(`summary api [${kind}]: default（未找到独立配置）`);
    return null;
}

function loadExistingDailyEvents(db, eventDate) {
    if (!eventDate) return '';
    const row = db.prepare(`
        SELECT summary_text FROM chat_summaries
        WHERE kind = 'activity' AND is_enabled = 1 AND event_date = ?
        ORDER BY id DESC LIMIT 1
    `).get(eventDate);
    if (!row) return '';
    let text = row.summary_text;
    try { text = encryption.decrypt(text); } catch (_) {}
    return (text || '').trim();
}

function buildVoyagePrompt({ dateDisplay, roundStart, roundEnd, startTime, endTime, conversationText }) {
    return fillRuntimeTemplate(activeVoyageTemplate(), {
        dateDisplay,
        roundStart,
        roundEnd,
        startTime,
        endTime,
        conversationText,
    });
}

function buildDailyPrompt({ logicalDate, endTime, volumeBlocks }) {
    return fillRuntimeTemplate(activeDailyTemplate(), {
        logicalDate,
        endTime,
        windowHours: DEFAULT_WINDOW_HOURS,
        volumeBlocks,
    });
}

function getPromptDefaults() {
    return {
        voyageDefault: DEFAULT_VOYAGE_PROMPT_TEMPLATE,
        dailyDefault: DEFAULT_DAILY_PROMPT_TEMPLATE,
        voyageActive: activeVoyageTemplate(),
        dailyActive: activeDailyTemplate(),
        voyageOverride: featureFlags.getVoyagePromptOverride() || '',
        dailyOverride: featureFlags.getDailyPromptOverride() || '',
        voyageEnabled: featureFlags.isOn('feature_voyage_enabled', true),
        dailyEnabled: featureFlags.isOn('feature_daily_events_enabled', true),
    };
}

function loadLatestVoyageText(db, chatId) {
    const row = db.prepare(`
        SELECT summary_text FROM chat_summaries
        WHERE chat_id = ? AND (kind = 'log' OR kind IS NULL) AND is_enabled = 1
        ORDER BY id DESC LIMIT 1
    `).get(chatId);
    if (!row) return '';
    let text = row.summary_text;
    try { text = encryption.decrypt(text); } catch (_) {}
    return (text || '').trim();
}

function finalizeDailyText(raw, endTs, logicalDate, existingDaily) {
    let dailyText = extractFencedBlock(raw, 'daily_events') || raw;
    dailyText = normalizeDailyEventsText(dailyText);
    if (dailyText) {
        dailyText = filterAiSubjectLines(dailyText, [AI.name].filter(Boolean));
        dailyText = enforceVolumeDensity(dailyText, endTs, {
            logicalDate,
            windowHours: DEFAULT_WINDOW_HOURS,
        });
    }
    dailyText = mergeDailyByVolume(
        existingDaily || '',
        dailyText || '',
        endTs,
        logicalDate,
        DEFAULT_WINDOW_HOURS,
    );
    if (dailyText) {
        dailyText = enforceVolumeDensity(dailyText, endTs, {
            logicalDate,
            windowHours: DEFAULT_WINDOW_HOURS,
        });
    }
    return dailyText || '';
}

/**
 * 生成对话总结（并行：voyage_log + daily_events）
 * @param {string|number} chatId
 * @param {number|null} startMessageId
 * @param {number|null} endMessageId
 */
async function generateChatSummary(chatId, startMessageId = null, endMessageId = null) {
    const lockKey = String(chatId);
    if (_inflight.has(lockKey)) {
        return { success: false, message: '整理进行中' };
    }
    _inflight.add(lockKey);
    try {
        return await _generateChatSummaryInner(chatId, startMessageId, endMessageId);
    } finally {
        _inflight.delete(lockKey);
    }
}

async function _generateChatSummaryInner(chatId, startMessageId = null, endMessageId = null) {
    try {
        const db = getDb();

        if (!startMessageId) {
            const chatInfo = db.prepare('SELECT last_summary_message_id FROM chats WHERE id = ?').get(chatId);
            startMessageId = (chatInfo && chatInfo.last_summary_message_id) || 0;
        }

        if (!endMessageId) {
            const latestMsg = db.prepare(
                'SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1'
            ).get(chatId);
            endMessageId = latestMsg?.id || 0;
        }

        if (startMessageId >= endMessageId) {
            return { success: false, message: '没有新消息需要总结' };
        }

        const messages = db.prepare(`
            SELECT id, sender, content, is_encrypted, timestamp, message_type
            FROM messages
            WHERE chat_id = ? AND id > ? AND id <= ?
            ORDER BY id ASC
        `).all(chatId, startMessageId, endMessageId);

        if (messages.length === 0) {
            return { success: false, message: '没有找到需要总结的消息' };
        }

        let roundCount = 0;
        const firstTimestamp = messages[0].timestamp;
        const lastTimestamp = messages[messages.length - 1].timestamp;
        const taggedEntries = [];
        let currentDate = '';

        const extractText = (msg) => {
            let content = msg.is_encrypted === 1 ? encryption.decrypt(msg.content) : msg.content;
            try {
                const parsed = JSON.parse(content);
                if (parsed.components && Array.isArray(parsed.components)) {
                    const textParts = parsed.components
                        .filter((c) => c.type === 'text')
                        .map((c) => c.content);
                    const repostParts = parsed.components
                        .filter((c) => c.type === 'snitch_repost')
                        .map((c) => {
                            let text = `【转发Snitch动态】${c.title || ''}`;
                            if (c.tag) text += ` [${c.tag}]`;
                            if (c.body) text += `\n${c.body}`;
                            if (c.source_url) text += `\n原文链接: ${c.source_url}`;
                            return text;
                        });
                    return [...textParts, ...repostParts].join('\n');
                }
                return content;
            } catch (e) {
                return content;
            }
        };

        const formatDateMarker = (dateStr) => {
            if (!dateStr) return '';
            const parts = dateStr.split('-');
            if (parts.length < 3) return dateStr;
            return `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
        };

        for (const msg of messages) {
            const msgDate = formatSingaporeFromISO(msg.timestamp, 'date');
            if (msgDate && msgDate !== currentDate) {
                currentDate = msgDate;
                const marker = `--- ${formatDateMarker(msgDate)} ---`;
                taggedEntries.push({ timestamp: msg.timestamp, line: marker, isMarker: true });
            }

            const msgTime = formatSingaporeFromISO(msg.timestamp, 'HH:mm');
            const timePrefix = msgTime ? `[${msgTime}] ` : '';

            if (msg.sender === 'draco' || msg.sender === 'ai') {
                roundCount++;
                const dracoText = extractText(msg);
                if (dracoText.trim()) {
                    const preview = dracoText.slice(0, 300);
                    const line = `${timePrefix}${AI.name}: ${preview}${dracoText.length > 300 ? '…' : ''}`;
                    taggedEntries.push({ timestamp: msg.timestamp, line });
                }
                continue;
            }

            const textContent = extractText(msg);
            const userLine = `${timePrefix}${USER.name}: ${textContent}`;
            taggedEntries.push({ timestamp: msg.timestamp, line: userLine });
        }

        console.log(`generateChatSummary: range ${startMessageId + 1}-${endMessageId}, ${roundCount} rounds`);

        const parseTs = (ts) => ({
            date: formatSingaporeFromISO(ts, 'date'),
            time: formatSingaporeFromISO(ts, 'HH:mm'),
        });
        const startParsed = parseTs(firstTimestamp);
        const endParsed = parseTs(lastTimestamp);
        const startTime = startParsed.time;
        const endTime = endParsed.time;
        const startDate = startParsed.date;
        const endDate = endParsed.date;
        const dateDisplay = startDate === endDate ? startDate : `${startDate}～${endDate}`;
        const logicalDate = logicalDateFromISO(lastTimestamp) || endDate;

        const previousRounds = db.prepare(`
            SELECT COALESCE(MAX(round_end), 0) as last_round
            FROM chat_summaries
            WHERE chat_id = ? AND (kind = 'log' OR kind IS NULL)
        `).get(chatId);

        const roundStart = previousRounds.last_round + 1;
        const roundEnd = roundStart + Math.max(roundCount, 1) - 1;

        const voyageOn = featureFlags.isOn('feature_voyage_enabled', true);
        // 事件线已彻底解耦：由 memory 独立后台调度统一生成（全局每逻辑日一行）。
        // 本函数只负责航海日志，绝不再写 activity，避免与后台调度互相覆盖。
        const dailyOn = false;

        // 两开关都关：不调 LLM，仍返回 success，让 brain 固化推进 cutoff
        if (!voyageOn && !dailyOn) {
            const keptVoyage = loadLatestVoyageText(db, chatId);
            const keptDaily = loadExistingDailyEvents(db, logicalDate);
            db.prepare('UPDATE chats SET last_summary_message_id = ? WHERE id = ?').run(
                endMessageId,
                chatId
            );
            console.log('generateChatSummary: voyage+daily 均关闭 → skip LLM, keep existing, advance cursor');
            return {
                success: true,
                skipped: true,
                summary: keptVoyage,
                dailyEvents: keptDaily,
                message: '航海日志与事件线已关闭，跳过整理',
                roundStart,
                roundEnd,
                eventDate: logicalDate,
            };
        }

        const conversationForVoyage = taggedEntries
            .map((e) => e.line)
            .filter(Boolean)
            .join('\n') || '（无）';

        const existingDaily = loadExistingDailyEvents(db, logicalDate);
        const { dirty } = buildVolumeBundles({
            dialogEntries: taggedEntries,
            existingText: existingDaily,
            endTs: lastTimestamp,
            logicalDate,
            windowHours: DEFAULT_WINDOW_HOURS,
        });
        const volumeBlocks = formatVolumeBlocksForPrompt(dirty);

        const voyagePrompt = buildVoyagePrompt({
            dateDisplay,
            roundStart,
            roundEnd,
            startTime,
            endTime,
            conversationText: conversationForVoyage,
        });
        const dailyPrompt = buildDailyPrompt({
            logicalDate,
            endTime,
            volumeBlocks,
        });

        const voyageApiId = resolveSummaryApiConfigId('voyage');
        const dailyApiId = resolveSummaryApiConfigId('daily');

        console.log(
            `generateChatSummary: parallel LLM voyage=${voyageOn} daily=${dailyOn && dirty.length > 0} dirtyVolumes=${dirty.length}`,
        );

        const summaryGen = { temperature: 0.4, maxOutputTokens: 4000 };
        const jobs = [];
        let voyageJobIndex = -1;
        let dailyJobIndex = -1;
        if (voyageOn) {
            voyageJobIndex = jobs.length;
            jobs.push({
                messages: [{ role: 'user', parts: [{ text: fillPrompt(voyagePrompt) }] }],
                apiConfigId: voyageApiId,
                generationConfig: summaryGen,
            });
        }
        if (dailyOn && dirty.length > 0) {
            dailyJobIndex = jobs.length;
            jobs.push({
                messages: [{ role: 'user', parts: [{ text: fillPrompt(dailyPrompt) }] }],
                apiConfigId: dailyApiId,
                generationConfig: summaryGen,
            });
        }

        let results = jobs.length ? await callLLMConcurrent(jobs) : [];
        let voyageResult = voyageJobIndex >= 0 ? results[voyageJobIndex] : null;
        const dailyResult = dailyJobIndex >= 0 ? results[dailyJobIndex] : null;

        // flash-lite 偶发空 content（thinking 吃预算）；voyage 硬失败会卡死固化，空则单次重试
        if (voyageOn && (!voyageResult || !voyageResult.reply)) {
            console.warn('generateChatSummary: voyage empty → retry once');
            try {
                voyageResult = await callLLM(
                    jobs[voyageJobIndex].messages,
                    null,
                    null,
                    summaryGen,
                    voyageApiId,
                );
            } catch (e) {
                console.error('generateChatSummary: voyage retry error:', e.message || e);
            }
        }

        let voyageText = '';
        if (voyageOn) {
            if (!voyageResult || !voyageResult.reply) {
                console.error('generateChatSummary: voyage API returned no content');
                return { success: false, message: '总结生成失败', error: '航海日志 API 未返回有效内容' };
            }
            voyageText = extractFencedBlock(voyageResult.reply, 'voyage_log') || voyageResult.reply.trim();
            const tokenCount = enc.encode(voyageText).length;
            console.log(`generateChatSummary: voyage ok, ${tokenCount} tokens`);
        } else {
            voyageText = loadLatestVoyageText(db, chatId);
            console.log('generateChatSummary: voyage 关闭 → keep existing');
        }

        let dailyText = '';
        if (!dailyOn) {
            dailyText = existingDaily || '';
            console.log('generateChatSummary: daily 关闭 → keep existing');
        } else if (dailyResult && dailyResult.reply) {
            dailyText = finalizeDailyText(dailyResult.reply, lastTimestamp, logicalDate, existingDaily);
        } else if (dirty.length === 0 && existingDaily) {
            dailyText = existingDaily;
            console.log('generateChatSummary: no dirty volumes, keep existing daily_events');
        } else if (dirty.length > 0) {
            console.log('generateChatSummary: daily API returned no content; keep existing');
            dailyText = existingDaily || '';
        }

        const eventDate = logicalDate;
        let logTokenCount = 0;

        if (voyageOn && voyageText) {
            const encryptedLog = encryption.encrypt(voyageText);
            logTokenCount = enc.encode(voyageText).length;

            db.prepare(`
                INSERT INTO chat_summaries (
                    chat_id, start_message_id, end_message_id,
                    round_start, round_end, summary_text, token_count, kind, event_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'log', ?)
            `).run(
                chatId,
                startMessageId + 1,
                endMessageId,
                roundStart,
                roundEnd,
                encryptedLog,
                logTokenCount,
                eventDate
            );
            console.log(`generateChatSummary: saved voyage rounds ${roundStart}-${roundEnd}`);
        } else if (!voyageOn) {
            logTokenCount = voyageText ? enc.encode(voyageText).length : 0;
            console.log('generateChatSummary: voyage 关闭 → 不写入新 log 行');
        }

        let activityTokenCount = 0;
        if (dailyOn && dailyText) {
            db.prepare(`
                DELETE FROM chat_summaries
                WHERE kind = 'activity' AND event_date = ?
            `).run(eventDate);

            const encryptedActivity = encryption.encrypt(dailyText);
            activityTokenCount = enc.encode(dailyText).length;
            db.prepare(`
                INSERT INTO chat_summaries (
                    chat_id, start_message_id, end_message_id,
                    round_start, round_end, summary_text, token_count, kind, event_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'activity', ?)
            `).run(
                chatId,
                startMessageId + 1,
                endMessageId,
                roundStart,
                roundEnd,
                encryptedActivity,
                activityTokenCount,
                eventDate
            );
            console.log(
                `generateChatSummary: daily_events merged ${activityTokenCount} tokens event_date=${eventDate}`
            );
        } else if (!dailyOn) {
            console.log('generateChatSummary: daily 关闭 → 不改写 activity');
        } else {
            console.log('generateChatSummary: no daily_events to save');
        }

        // 无论是否写了摘要，推进游标，保证固化 / 下次整理不卡死
        db.prepare('UPDATE chats SET last_summary_message_id = ? WHERE id = ?').run(
            endMessageId,
            chatId
        );

        return {
            success: true,
            summary: voyageText,
            dailyEvents: dailyText || '',
            roundStart,
            roundEnd,
            tokenCount: logTokenCount,
            activityTokenCount,
            eventDate,
            voyageSkipped: !voyageOn,
            dailySkipped: !dailyOn,
        };
    } catch (error) {
        console.error('generateChatSummary: 内部错误:', error.message, error.stack);
        return { success: false, message: '生成总结时出错', error: error.message };
    }
}

/**
 * 若距上次整理达到间隔，则后台生成（立即返回，不阻塞）。
 * @returns {{ triggered: boolean, roundsSince: number, interval: number }}
 */
async function checkAndTriggerSummary(chatId, label) {
    try {
        const db = getDb();
        const chatConfig = db.prepare(
            'SELECT last_summary_message_id, summary_interval FROM chats WHERE id = ?'
        ).get(chatId);
        if (!chatConfig) {
            return { triggered: false, roundsSince: 0, interval: DEFAULT_SUMMARY_INTERVAL };
        }
        const lastSummaryId = chatConfig.last_summary_message_id || 0;
        let interval = chatConfig.summary_interval;
        if (interval == null || interval <= 0) interval = DEFAULT_SUMMARY_INTERVAL;

        const roundsSinceLastSummary = db.prepare(`
            SELECT COUNT(*) as count
            FROM messages
            WHERE chat_id = ? AND id > ? AND sender IN ('draco', 'ai')
        `).get(chatId, lastSummaryId).count;

        console.log(
            `📊 [${label}] 整理检测: 距上次${roundsSinceLastSummary}轮，阈值${interval}轮`
        );

        if (roundsSinceLastSummary >= interval) {
            console.log(`🎯 [${label}] 达到整理频率，后台生成…`);
            generateChatSummary(chatId)
                .then((result) => {
                    if (result.success) {
                        console.log(
                            `✅ [${label}] 整理完成: 第${result.roundStart}-${result.roundEnd}轮`
                        );
                    } else {
                        console.error(`❌ [${label}] 整理失败:`, result.message);
                    }
                })
                .catch((err) => {
                    console.error(`❌ [${label}] 整理异常:`, err);
                });
            return { triggered: true, roundsSince: roundsSinceLastSummary, interval };
        }
        return { triggered: false, roundsSince: roundsSinceLastSummary, interval };
    } catch (error) {
        console.error(`❌ [${label}] 整理检测失败:`, error);
        return { triggered: false, roundsSince: 0, interval: DEFAULT_SUMMARY_INTERVAL, error: error.message };
    }
}

async function checkAllChats() {
    try {
        const db = getDb();
        const chats = db.prepare('SELECT id FROM chats').all();
        for (const { id } of chats) {
            await checkAndTriggerSummary(id, 'Cron兜底');
        }
    } catch (error) {
        console.error('[Summary] checkAllChats 失败:', error);
    }
}

/**
 * 重写【全局】事件线（每逻辑日一行，合并所有会话；不写 voyage）。
 * - 素材 = 本逻辑日所有会话的原始对话 + 已有事件线卷（有卷拉卷、无卷拉原文）
 * - 失败/空不覆盖旧行，单次重试
 * @param {{ eventDate?: string, lookbackMessages?: number }} [opts]
 */
async function regenerateDailyEvents(opts = {}) {
    const lockKey = 'daily:__global__';
    if (_inflight.has(lockKey)) {
        return { success: false, message: '整理进行中' };
    }
    if (!featureFlags.isOn('feature_daily_events_enabled', true)) {
        return { success: true, skipped: true, message: '今日事件线已关闭', dailyEvents: '' };
    }
    _inflight.add(lockKey);
    try {
        const db = getDb();
        const lookback = Math.max(20, Math.min(800, Number(opts.lookbackMessages) || 300));
        // 全局：不按 chat_id 过滤，取最近消息后按逻辑日筛
        const rows = db.prepare(`
            SELECT id, chat_id, sender, content, is_encrypted, timestamp, message_type
            FROM messages
            ORDER BY id DESC
            LIMIT ?
        `).all(lookback).reverse();

        if (!rows.length) {
            return { success: false, message: '没有消息' };
        }

        const lastTs = rows[rows.length - 1].timestamp;
        const eventDate = opts.eventDate || logicalDateFromISO(lastTs) || formatSingaporeFromISO(lastTs, 'date');
        const dayMsgs = rows.filter((m) => logicalDateFromISO(m.timestamp) === eventDate);
        const messages = dayMsgs.length ? dayMsgs : rows;
        const endTs = messages[messages.length - 1].timestamp;
        const endTime = formatSingaporeFromISO(endTs, 'HH:mm');

        const extractText = (msg) => {
            let content = msg.is_encrypted === 1 ? encryption.decrypt(msg.content) : msg.content;
            try {
                const parsed = JSON.parse(content);
                if (parsed.components && Array.isArray(parsed.components)) {
                    return parsed.components
                        .filter((c) => c.type === 'text')
                        .map((c) => c.content)
                        .join('\n');
                }
                return content;
            } catch (_) {
                return content;
            }
        };

        const taggedEntries = [];
        for (const msg of messages) {
            const msgTime = formatSingaporeFromISO(msg.timestamp, 'HH:mm');
            const timePrefix = msgTime ? `[${msgTime}] ` : '';
            if (msg.sender === 'draco' || msg.sender === 'ai') {
                const t = extractText(msg);
                if (!t.trim()) continue;
                const preview = t.slice(0, 300);
                taggedEntries.push({
                    timestamp: msg.timestamp,
                    line: `${timePrefix}${AI.name}: ${preview}${t.length > 300 ? '…' : ''}`,
                });
                continue;
            }
            taggedEntries.push({
                timestamp: msg.timestamp,
                line: `${timePrefix}${USER.name}: ${extractText(msg)}`,
            });
        }

        const existingDaily = loadExistingDailyEvents(db, eventDate);
        const { all } = buildVolumeBundles({
            dialogEntries: taggedEntries,
            existingText: existingDaily,
            endTs,
            logicalDate: eventDate,
            windowHours: DEFAULT_WINDOW_HOURS,
        });
        const dirty = all.filter((b) => b.dialog.length > 0 || b.existing.length > 0);
        if (!dirty.length) {
            return { success: false, message: '本逻辑日无可整理素材' };
        }

        const prompt = buildDailyPrompt({
            logicalDate: eventDate,
            endTime,
            volumeBlocks: formatVolumeBlocksForPrompt(dirty),
        });

        console.log(`regenerateDailyEvents: GLOBAL date=${eventDate} vols=${dirty.length} msgs=${messages.length}`);
        const dailyApiId = resolveSummaryApiConfigId('daily');
        const callOnce = () => callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            '',
            null,
            {},
            dailyApiId,
        );
        let result = null;
        try {
            result = await callOnce();
        } catch (e) {
            console.warn('regenerateDailyEvents: call error:', e.message || e);
        }
        if (!result || !result.reply) {
            console.warn('regenerateDailyEvents: empty/error → retry once');
            await new Promise((r) => setTimeout(r, 1500));
            try {
                result = await callOnce();
            } catch (e) {
                console.error('regenerateDailyEvents: retry error:', e.message || e);
            }
        }
        if (!result || !result.reply) {
            return { success: false, message: '事件线重写失败（保留旧行）', error: 'API未返回有效内容' };
        }

        const dailyText = finalizeDailyText(result.reply, endTs, eventDate, existingDaily);
        if (!dailyText) {
            return { success: false, message: '无法解析 daily_events（保留旧行）' };
        }

        // 成功才覆盖当日旧行（全局一行，chat_id 用统一标记）
        // 该标记需在 chats 表存在（chat_summaries.chat_id 有外键）
        db.prepare('INSERT OR IGNORE INTO chats (id, name) VALUES (?, ?)').run('__daily__', '每日事件线');
        db.prepare(`DELETE FROM chat_summaries WHERE kind = 'activity' AND event_date = ?`).run(eventDate);
        const encryptedActivity = encryption.encrypt(dailyText);
        const activityTokenCount = enc.encode(dailyText).length;
        const startId = messages[0].id;
        const endId = messages[messages.length - 1].id;
        db.prepare(`
            INSERT INTO chat_summaries (
                chat_id, start_message_id, end_message_id,
                round_start, round_end, summary_text, token_count, kind, event_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'activity', ?)
        `).run('__daily__', startId, endId, 0, 0, encryptedActivity, activityTokenCount, eventDate);

        console.log(`regenerateDailyEvents: ok tokens=${activityTokenCount} date=${eventDate}`);
        return {
            success: true,
            dailyEvents: dailyText,
            activityTokenCount,
            eventDate,
            messageCount: messages.length,
        };
    } catch (error) {
        console.error('regenerateDailyEvents:', error.message, error.stack);
        return { success: false, message: '事件线重写出错（保留旧行）', error: error.message };
    } finally {
        _inflight.delete(lockKey);
    }
}

module.exports = {
    generateChatSummary,
    checkAndTriggerSummary,
    checkAllChats,
    regenerateDailyEvents,
    extractFencedBlock,
    normalizeDailyEventsText,
    resolveSummaryApiConfigId,
    buildVoyagePrompt,
    buildDailyPrompt,
    getPromptDefaults,
    DEFAULT_VOYAGE_PROMPT_TEMPLATE,
    DEFAULT_DAILY_PROMPT_TEMPLATE,
    DEFAULT_SUMMARY_INTERVAL,
};
