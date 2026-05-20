'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

const BOT_TOKEN = process.env.SIM_BOT_TOKEN || 'YOUR_SIM_BOT_TOKEN_HERE';
const CHAT_ID   = process.env.SIM_CHAT_ID   || 'YOUR_SIM_CHAT_ID_HERE';

const API_LATEST  = 'https://api.api168168.com/pks/getLotteryPksInfo.do?lotCode=10037';
const API_HISTORY = 'https://api.api168168.com/pks/getPksHistoryList.do?lotCode=10037';

const HIGHLIGHT        = 60;
const MIN_N            = 6;
const CHECKS           = [2, 3, 4, 5, 6, 7];
// Dynamic ladder — scales with capital (mid-risk: ~45-50% exposure)
const LADDER_TIERS = [
    { capital:  2200, base:  12 },
    { capital:  2900, base:  15 },
    { capital:  3700, base:  20 },
    { capital:  4800, base:  25 },
    { capital:  6300, base:  35 },
    { capital:  8000, base:  45 },
    { capital: 10500, base:  60 },
    { capital: 13500, base:  75 },
    { capital: 17500, base: 100 },
    { capital: 22500, base: 125 },
    { capital: Infinity, base: 175 },
];

function getCurrentBase() {
    const tier = LADDER_TIERS.find(t => db.balance < t.capital);
    return tier ? tier.base : 350;
}

function getCurrentLadder() {
    const base = getCurrentBase();
    return [1, 2, 4, 8, 16, 32].map(m => base * m);
}

// Keep BET_LADDER as a reference for startup display only
const BET_LADDER = [12, 24, 48, 96, 192, 384];
const RECOVERY_AFTER   = 4;
const SPLIT_FROM       = 3;
const MAX_RECOVERY_SIGS = 6;
const STARTING_BALANCE = 1000;
const HARD_CAP_LOSS    = 1000;
const DAILY_GROWTH     = 0.30;
const RESUME_HOUR_MYT  = 14;
const REBUILD_EVERY    = 15;
const PAYOUT_RATE      = 0.96;
const MAX_RETRIES      = 5;
const SMART_RECOVERY_FROM = 2;
const SPLIT_BET_CAP       = 200;
const MAX_RECOVERY_ROUNDS = 3;

const posLabels = ['冠军','亚军','第三','第四','第五','第六','第七','第八','第九','第十'];

function buildDimensions() {
    const dims = [];
    for (let i = 0; i < 10; i++) {
        const pos = i;
        dims.push({
            id:`p${pos+1}DS`, label:`第${pos+1}名 单双`,
            fn: r => { const n=r.preDrawCode.split(',').map(Number)[pos]; return n%2!==0?'单':'双'; }
        });
        dims.push({
            id:`p${pos+1}DX`, label:`第${pos+1}名 大小`,
            fn: r => { const n=r.preDrawCode.split(',').map(Number)[pos]; return n<=5?'小':'大'; }
        });
    }
    return dims;
}

function countStreakFollowup(vals, streakLen) {
    const res = { bySide:{} };
    for (let i = streakLen; i < vals.length; i++) {
        const w    = vals.slice(i-streakLen, i);
        const side = w[0];
        if (!w.every(v=>v===side)) continue;
        const before = vals[i-streakLen-1];
        if (before === side) continue;
        const broke = vals[i]!==side;
        if (!res.bySide[side]) res.bySide[side]={break:0,total:0};
        res.bySide[side].total++;
        if (broke) res.bySide[side].break++;
    }
    return res;
}

function buildSignalTable(rawRecords) {
    const dims = buildDimensions();
    const sigs = [];
    for (const dim of dims) {
        const vals = rawRecords.map(dim.fn);
        for (const len of CHECKS) {
            const res = countStreakFollowup(vals, len);
            for (const [side, s] of Object.entries(res.bySide)) {
                if (s.total < MIN_N) continue;
                const pair = dim.id.includes('DS')?['单','双']:['大','小'];
                const opp  = pair.find(x=>x!==side);
                const bPct = Math.round(s.break/s.total*100);
                if (bPct >= HIGHLIGHT) {
                    sigs.push({ dimId:dim.id, label:dim.label, side, len, action:'杀', chase:opp, pct:bPct, n:s.total });
                }
            }
        }
    }
    sigs.sort((a,b)=>b.pct-a.pct||b.n-a.n);
    return sigs;
}

function matchesStreak(rawHistory, dimFn, side, len) {
    if (rawHistory.length < len) return false;
    const tail = rawHistory.slice(-len).map(dimFn);
    if (!tail.every(v=>v===side)) return false;
    if (rawHistory.length>len && dimFn(rawHistory[rawHistory.length-len-1])===side) return false;
    return true;
}

function currentStreakLen(rawHistory, dimFn, side) {
    let n=0;
    for (let i=rawHistory.length-1;i>=0;i--) { if(dimFn(rawHistory[i])===side)n++; else break; }
    return n;
}

const db = {
    rawHistory    : [],
    dims          : [],
    signalTable   : [],
    lastIssue     : null,
    startIssue    : null,
    nextDrawAt    : null,
    drawCount     : 0,
    shownStart    : false,
    shownLast     : false,
    pendingSignals: [],
    balance       : STARTING_BALANCE,
    totalBet      : 0,
    totalWin      : 0,
    totalLoss     : 0,
    drawsPlayed   : 0,
    peakBalance   : STARTING_BALANCE,
    troughBalance : STARTING_BALANCE,
    busted        : false,
    globalRetry   : 0,
    lastWinBalance: STARTING_BALANCE,
    recoveryRounds: 0,
    dayStart      : STARTING_BALANCE,
    dailyTarget   : Math.ceil(STARTING_BALANCE * (1 + DAILY_GROWTH)),
    stopped       : false,
    resumeAt      : null,
};

function evaluateSignals() {
    const active = [];
    const seen   = new Set();
    const MIN_STREAK = 3;

    for (const dim of db.dims) {
        if (db.rawHistory.length === 0) continue;
        const lastVal   = dim.fn(db.rawHistory[db.rawHistory.length-1]);
        const streakLen = currentStreakLen(db.rawHistory, dim.fn, lastVal);
        if (streakLen < MIN_STREAK) continue;

        const vals = db.rawHistory.map(dim.fn);
        const res  = countStreakFollowup(vals, streakLen);
        const s    = res.bySide[lastVal];
        if (!s || s.total < MIN_N) continue;

        const pair  = dim.id.includes('DS')?['单','双']:['大','小'];
        const opp   = pair.find(x=>x!==lastVal);
        const bPct  = Math.round(s.break/s.total*100);
        const cPct  = 100 - bPct;

        if (cPct >= 70 && s.total >= 15) {
            const key = `${dim.id}|${lastVal}|${streakLen}|追`;
            if (!seen.has(key)) {
                seen.add(key);
                active.push({ dimId:dim.id, label:dim.label, side:lastVal, len:streakLen, action:'追', chase:lastVal, pct:cPct, n:s.total });
            }
        }
        if (bPct >= HIGHLIGHT) {
            const key = `${dim.id}|${lastVal}|${streakLen}|杀`;
            if (!seen.has(key)) {
                seen.add(key);
                active.push({ dimId:dim.id, label:dim.label, side:lastVal, len:streakLen, action:'杀', chase:opp, pct:bPct, n:s.total });
            }
        }
    }

    active.sort((a,b)=>b.pct-a.pct||b.n-a.n);
    return active;
}

function nextResume() {
    const now    = new Date();
    const resume = new Date(now);
    resume.setUTCHours(RESUME_HOUR_MYT-8, 0, 0, 0);
    if (now >= resume) resume.setUTCDate(resume.getUTCDate()+1);
    return resume;
}

function getRecoverySignals() {
    // During recovery, use ALL available signals >= 55% break rate
    // regardless of current HIGHLIGHT threshold
    // Always target a 4-way split for variance reduction
    const active = [];
    const seen   = new Set();
    const RECOVERY_MIN_PCT = 55;
    const RECOVERY_MIN_N   = 5;
    const MIN_STREAK       = 3;

    for (const dim of db.dims) {
        if (db.rawHistory.length === 0) continue;
        const lastVal   = dim.fn(db.rawHistory[db.rawHistory.length-1]);
        const streakLen = currentStreakLen(db.rawHistory, dim.fn, lastVal);
        if (streakLen < MIN_STREAK) continue;

        const vals = db.rawHistory.map(dim.fn);
        const res  = countStreakFollowup(vals, streakLen);
        const s    = res.bySide[lastVal];
        if (!s || s.total < RECOVERY_MIN_N) continue;

        const pair = dim.id.includes('DS')?['单','双']:['大','小'];
        const opp  = pair.find(x=>x!==lastVal);
        const bPct = Math.round(s.break/s.total*100);

        if (bPct >= RECOVERY_MIN_PCT) {
            const key = `${dim.id}|${lastVal}|${streakLen}`;
            if (!seen.has(key)) {
                seen.add(key);
                active.push({ dimId:dim.id, label:dim.label, side:lastVal, len:streakLen, action:'杀', chase:opp, pct:bPct, n:s.total });
            }
        }
    }

    active.sort((a,b) => b.pct-a.pct || b.n-a.n);
    return active;
}

function assignBets(signals) {
    if (signals.length === 0) return [];

    const LADDER = getCurrentLadder();
    const BASE   = getCurrentBase();

    const inRecovery = db.globalRetry >= SMART_RECOVERY_FROM ||
                       signals.some(s => s.recoveryMode);

    if (inRecovery) {
        const target  = db.lastWinBalance + BASE;
        const deficit = Math.max(target - db.balance, 0);

        if (deficit === 0) {
            db.globalRetry = 0;
            const best = signals.slice().sort((a,b) => b.pct-a.pct || b.n-a.n)[0];
            return [{ ...best, betAmt: BASE, recoveryMode: false }];
        }

        // Get expanded signal pool (>=55%) for recovery
        const recoveryPool = getRecoverySignals();

        // Always aim for 4-way split, fall back to available signals
        const TARGET_SPLITS = 4;
        const pool = recoveryPool.length >= TARGET_SPLITS
            ? recoveryPool.slice(0, TARGET_SPLITS)
            : recoveryPool.length > 0
                ? recoveryPool
                : signals.slice(0, TARGET_SPLITS); // fallback to normal signals

        // Dynamic: if single bet fits, use single; otherwise split across pool
        const singleBet = Math.ceil(deficit / PAYOUT_RATE);
        const splitCount = pool.length;

        if (singleBet <= BASE || pool.length === 1) {
            // Small deficit — single bet
            return [{ ...pool[0], betAmt: Math.max(singleBet, BASE), recoveryMode: true }];
        } else {
            // Split across pool — each signal covers 1/N of deficit
            let perSig = Math.ceil((deficit / splitCount) / PAYOUT_RATE);
            perSig     = Math.max(perSig, BASE);
            return pool.map(s => ({ ...s, betAmt: perSig, recoveryMode: true }));
        }
    }

    const normal = signals.filter(s => s.retryCount < SPLIT_FROM);
    const high   = signals.filter(s => s.retryCount >= SPLIT_FROM);
    const result = [];

    if (high.length === 0) {
        const carryNormal = normal.filter(s => s.retryCount > 0).sort((a,b) => b.retryCount-a.retryCount || b.pct-a.pct)[0];
        const freshNormal = normal.filter(s => s.retryCount === 0).sort((a,b) => b.pct-a.pct || b.n-a.n)[0];
        const best        = carryNormal || freshNormal;
        result.push({ ...best, betAmt: LADDER[Math.min(db.globalRetry, LADDER.length-1)] });
    } else {
        const carryNormal = normal.filter(s => s.retryCount > 0);
        const pool        = [...high, ...carryNormal];
        const sumLost     = high.reduce((sum, s) => sum+(s.totalLost||0), 0);
        const totalNeeded = Math.max(sumLost*1.1, LADDER[SPLIT_FROM]);
        const basePerSig  = Math.ceil(totalNeeded/pool.length);
        for (const sig of pool) {
            result.push({ ...sig, betAmt: Math.max(basePerSig, 1) });
        }
    }
    return result;
}

function secsToNext() {
    if (!db.nextDrawAt) return null;
    return Math.max(0,(db.nextDrawAt-Date.now())/1000);
}
const PAD2 = n=>String(n).padStart(2,' ');
const fmt  = n=>n.toFixed(0);

const bot = new TelegramBot(BOT_TOKEN,{polling:false});
function send(text) {
    return bot.sendMessage(CHAT_ID,text,{parse_mode:'Markdown',disable_web_page_preview:true})
              .catch(err=>console.error('[send error]',err.message));
}


function buildMsg(raw, bettedSignals, verResults, nextIssue) {
    const nums  = raw.preDrawCode.split(',').map(Number);
    const time  = raw.preDrawTime.slice(11,19);
    const s     = secsToNext();
    const nextT = db.nextDrawAt?db.nextDrawAt.toTimeString().slice(0,8):'—';
    const secsL = s!==null?Math.ceil(s):'—';
    const lines = [];

    lines.push(`\`#${raw.preDrawIssue}\`  ⏰ \`${time}\``);
    lines.push(`位置:  ${posLabels.map(l=>l.padEnd(4)).join(' ')}`);
    lines.push(`号码:  ${nums.map(n=>PAD2(n)).join('  ')}`);
    lines.push(`单双:  ${nums.map(n=>n%2!==0?'单':'双').join('  ')}`);
    lines.push(`大小:  ${nums.map(n=>n<=5?'小':'大').join('  ')}`);
    lines.push(`冠亚和: ${raw.sumFS}  ${raw.sumFS%2!==0?'单':'双'}  ${raw.sumFS<12?'小':'大'}`);

    if (verResults.length > 0) {
        const hits    = verResults.filter(v=>v.hit).length;
        const roundPL = verResults.reduce((sum,v)=>sum+(v.hit?v.betAmt*PAYOUT_RATE:-v.betAmt),0);
        lines.push('');
        lines.push(`📊 上期验证 (${hits}/${verResults.length} 命中) P&L: ${roundPL>=0?'+':''}${fmt(roundPL)}:`);
        for (const v of verResults) {
            const plStr = v.hit?`+${fmt(v.betAmt*PAYOUT_RATE)}`:`-${fmt(v.betAmt)}`;
            const mode  = v.recoveryMode?'🔄':'';
            const aIcon = v.action==='追'?'🔁':'⚔️';
            lines.push(`  ${v.hit?'✅':'❌'} ${v.label} 连${v.streakLen}${v.side} ${v.action}${v.chase}${aIcon} → 实际 *${v.actual}* (${plStr}) ${mode}`);
        }
    }

    lines.push('');
    const todayPL    = db.balance - db.dayStart;
    const targetLeft = Math.max(0, db.dailyTarget-db.balance);
    const profitMode = db.balance > db.dayStart ? '📈' : '📉';
    lines.push(`💰 余额: *${fmt(db.balance)}* | 峰值: ${fmt(db.peakBalance)} | 谷值: ${fmt(db.troughBalance)}`);
    lines.push(`${profitMode} 今日: ${todayPL>=0?'+':''}${fmt(todayPL)} | 目标: ${fmt(db.dailyTarget)} | 还差: ${fmt(targetLeft)}`);
    lines.push(`📊 总投: ${fmt(db.totalBet)} | 赢: +${fmt(db.totalWin)} | 输: -${fmt(db.totalLoss)} | 净: ${db.totalWin-db.totalLoss>=0?'+':''}${fmt(db.totalWin-db.totalLoss)}`);

    lines.push('');
    lines.push(`\`─────────────────────────\``);
    lines.push(`📌 下批 *#${nextIssue}* 下注:`);
    lines.push('');

    if (db.busted) {
        lines.push(`🛑 *爆仓！已永久停止*`);
    } else if (db.stopped) {
        if (db.recoveryRounds >= MAX_RECOVERY_ROUNDS) {
            lines.push(`🛑 *连续回本失败，今日停止*`);
        } else {
            lines.push(`🎯 *今日+30%达成！已停止*`);
        }
        lines.push(`_次日 2pm MYT 恢复_`);
    } else if (bettedSignals.length === 0) {
        lines.push('_暂无信号_');
    } else {
        const totalNextBet = bettedSignals.reduce((sum,s)=>sum+s.betAmt,0);
        const isRecovery   = bettedSignals.some(s=>s.recoveryMode);
        const highCount    = bettedSignals.filter(s=>s.retryCount>=SPLIT_FROM).length;
        if (isRecovery)       lines.push(`🔄 *回本模式* 目标: ${fmt(db.lastWinBalance+getCurrentBase())} | 回本轮: ${db.recoveryRounds}/${MAX_RECOVERY_ROUNDS}`);
        else if (highCount>1) lines.push(`⚠️ _均摊 ×${highCount}_`);
        lines.push('');
        lines.push(`⭐  总注: *${fmt(totalNextBet)}*`);
        lines.push('');

        for (const sig of bettedSignals) {
            const retry  = sig.retryCount>0?` ❌×${sig.retryCount}`:'';
            const mode   = sig.recoveryMode?'🔄':'';
            const aIcon  = sig.action==='追'?'🔁':'⚔️';
            const dim    = db.dims.find(d=>d.id===sig.dimId);
            const sLen   = dim?currentStreakLen(db.rawHistory,dim.fn,sig.side):sig.len;
            lines.push(`${sig.label} 连${sLen}${sig.side}${retry} ${mode}`);
            lines.push(`${sig.action}${sig.chase}${aIcon}  下注 *${fmt(sig.betAmt)}*  _(${sig.pct}% n=${sig.n})_`);
            lines.push('');
        }
    }

    lines.push(`⏳ 下条🐲出末 ⚠️ : \`${nextT}\` (约${secsL}秒后) ⚠️`);
    return lines.join('\n');
}

async function init() {
    console.log('[init] 加载历史数据...');
    let data;
    for (let attempt=1; attempt<=3; attempt++) {
        try {
            const res = await axios.get(API_HISTORY, {timeout:20_000});
            data = res.data;
            break;
        } catch(e) {
            console.log('[init] attempt '+attempt+' failed: '+e.message);
            if (attempt===3) throw e;
            await new Promise(r=>setTimeout(r,3000));
        }
    }
    if (data.errorCode!==0) throw new Error(data.message);
    db.rawHistory  = data.result.data.slice().reverse();
    db.startIssue  = db.rawHistory[0].preDrawIssue;
    db.lastIssue   = db.rawHistory[db.rawHistory.length-1].preDrawIssue;
    console.log(`[init] ${db.rawHistory.length} 期 (${db.startIssue} → ${db.lastIssue})`);
    db.dims        = buildDimensions();
    db.signalTable = buildSignalTable(db.rawHistory);
    console.log(`[init] 静态信号表: ${db.signalTable.length} 条 (>=${HIGHLIGHT}%)`);
    console.log(`[init] 动态模式: 每期实时计算当前连线长度和胜率`);
}

async function poll() {
    const now = new Date();

    if (db.stopped && db.resumeAt && now >= db.resumeAt) {
        db.stopped        = false;
        db.resumeAt       = null;
        db.dayStart       = db.balance;
        db.dailyTarget    = Math.ceil(db.balance*(1+DAILY_GROWTH));
        db.pendingSignals = [];
        db.globalRetry    = 0;
        db.recoveryRounds = 0;
        console.log(`\n[RESUME] 新一天! 余额:${fmt(db.balance)} 目标:${fmt(db.dailyTarget)}`);
        send([
            `☀️ *新的一天开始！*`,
            `💰 余额: *${fmt(db.balance)}*`,
            `🎯 今日目标: *${fmt(db.dailyTarget)}* (+30%)`,
        ].join('\n'));
    }

    const s=secsToNext(), isNear=s!==null&&s<=15, nextMs=isNear?4_000:15_000;
    if (s!==null) {
        if (!db.shownStart&&s>55){console.log('\n[countdown] 新一期 ~60s');db.shownStart=true;}
        if (!db.shownLast&&s<=30){console.log(`\n[countdown] 最后 ${Math.ceil(s)}s`);db.shownLast=true;}
    }

    let raw,nextTime,nextIssue;
    try {
        const {data}=await axios.get(API_LATEST,{timeout:10_000});
        if (data.errorCode!==0) throw new Error(data.message);
        raw=data.result.data; nextTime=raw.drawTime; nextIssue=raw.drawIssue;
    } catch(e){console.error('\n[fetch error]',e.message);setTimeout(poll,nextMs);return;}

    db.nextDrawAt=new Date(nextTime.replace(' ','T'));

    if (raw.preDrawIssue!==db.lastIssue) {
        db.lastIssue=raw.preDrawIssue; db.drawCount++;
        db.shownStart=false; db.shownLast=false;
        console.log(`\n[#${db.drawCount}] 期${raw.preDrawIssue} ${raw.preDrawTime.slice(11,19)}`);

        db.rawHistory.push(raw);
        if (db.rawHistory.length>1000) db.rawHistory.shift();

        // Check for ladder tier change
        const newBase = getCurrentBase();
        if (!db._lastBase) db._lastBase = newBase;
        if (newBase !== db._lastBase) {
            console.log(`  [TIER UP] 资金升档! base ${db._lastBase}→${newBase} 梯注:${getCurrentLadder().join('→')}`);
            send(`🎉 *资金升档！*\n新梯注: ${getCurrentLadder().join('→')} (base ${newBase})\n💰 余额: ${fmt(db.balance)}`);
            db._lastBase = newBase;
        }

        if (db.drawCount % REBUILD_EVERY === 0) {
            db.signalTable = buildSignalTable(db.rawHistory);
            console.log(`  [REBUILD] 信号表刷新 第${db.drawCount}期: ${db.signalTable.length} 条`);
        }

        if (db.busted || db.stopped) {
            setTimeout(poll,nextMs);
            return;
        }

        const verResults = [];
        const carryOver  = [];

        for (const ps of db.pendingSignals) {
            if (ps.nextIssue !== raw.preDrawIssue) continue;
            const dim    = db.dims.find(d=>d.id===ps.dimId);
            const actual = dim?dim.fn(raw):'?';
            const hit    = actual===ps.chase;

            if (hit) {
                db.balance  += ps.betAmt*PAYOUT_RATE;
                db.totalWin += ps.betAmt*PAYOUT_RATE;
            } else {
                db.balance   -= ps.betAmt;
                db.totalLoss += ps.betAmt;
            }
            db.totalBet     += ps.betAmt;
            db.peakBalance   = Math.max(db.peakBalance, db.balance);
            db.troughBalance = Math.min(db.troughBalance, db.balance);
            db.drawsPlayed++;

            const consecutiveLoss = hit?0:(ps.consecutiveLoss||0)+1;
            verResults.push({ label:ps.label, side:ps.side, streakLen:ps.len, chase:ps.chase, action:ps.action, actual, hit, betAmt:ps.betAmt, recoveryMode:ps.recoveryMode||false });
            console.log(`  [${hit?'HIT':'MISS'}] [${ps.action}] ${ps.label} ${ps.chase} → ${actual} | bet:${ps.betAmt} bal:${fmt(db.balance)}`);

            if (db.balance <= STARTING_BALANCE-HARD_CAP_LOSS) {
                db.busted = true;
                console.log('  [BUSTED] 爆仓！');
            }

            if (!db.busted) {
                if (hit) {
                    db.globalRetry    = 0;
                    db.recoveryRounds = 0;
                    if (!ps.recoveryMode) {
                        db.lastWinBalance = db.balance;
                    }
                    console.log(`  [WIN] ${ps.label} 已命中 recovery:${ps.recoveryMode} lastWin:${fmt(db.lastWinBalance)}`);
                } else if (ps.action === '追') {
                    db.globalRetry = Math.min(db.globalRetry+1, BET_LADDER.length-1);
                    console.log(`  [DROP] ${ps.label} 追信号失败，丢弃 globalRetry→${db.globalRetry}`);
                } else if (ps.retryCount+1 >= MAX_RETRIES) {
                    db.globalRetry = Math.min(db.globalRetry+1, BET_LADDER.length-1);
                    console.log(`  [DROP] ${ps.label} 超过${MAX_RETRIES}次失败，丢弃 globalRetry→${db.globalRetry}`);
                } else {
                    db.globalRetry = Math.min(db.globalRetry+1, BET_LADDER.length-1);
                    const newTotalLost = (ps.totalLost||0)+ps.betAmt;
                    const stayRecovery = ps.recoveryMode || db.globalRetry >= SMART_RECOVERY_FROM;
                    carryOver.push({
                        ...ps,
                        retryCount    : ps.retryCount+1,
                        totalLost     : newTotalLost,
                        consecutiveLoss,
                        recoveryMode  : stayRecovery,
                        nextIssue,
                    });
                    console.log(`  [LOSS] globalRetry→${db.globalRetry} recovery:${stayRecovery} totalLost:${newTotalLost}`);
                }
            }
        }

        if (db.busted) {
            send(buildMsg(raw, [], verResults, nextIssue));
            setTimeout(poll,nextMs);
            return;
        }

        // Track recovery rounds
        const recoveryRound  = verResults.some(v => v.recoveryMode);
        const allRecoveryHit = recoveryRound && verResults.filter(v=>v.recoveryMode).every(v=>v.hit);
        const anyRecoveryHit = recoveryRound && verResults.some(v=>v.recoveryMode && v.hit);
        const allRecoveryLost = recoveryRound && verResults.filter(v=>v.recoveryMode).every(v=>!v.hit);

        if (allRecoveryHit) {
            db.lastWinBalance = db.balance;
            db.globalRetry    = 0;
            db.recoveryRounds = 0;
            console.log(`  [RECOVERY COMPLETE] lastWinBalance→${fmt(db.lastWinBalance)}`);
        } else if (anyRecoveryHit) {
            console.log(`  [RECOVERY PARTIAL] continuing...`);
        } else if (allRecoveryLost) {
            db.recoveryRounds++;
            console.log(`  [RECOVERY FAIL] round ${db.recoveryRounds}/${MAX_RECOVERY_ROUNDS}`);
            if (db.recoveryRounds >= MAX_RECOVERY_ROUNDS) {
                db.stopped  = true;
                db.resumeAt = nextResume();
                console.log(`  [STOP] 连续${MAX_RECOVERY_ROUNDS}次回本失败，今日停止`);
            }
        }

        if (db.balance >= db.dailyTarget) {
            db.stopped  = true;
            db.resumeAt = nextResume();
            console.log(`  [TARGET] +30%达成! 次日2pm MYT恢复`);
            send(buildMsg(raw, [], verResults, nextIssue));
            setTimeout(poll,nextMs);
            return;
        }

        if (db.stopped) {
            send(buildMsg(raw, [], verResults, nextIssue));
            setTimeout(poll,nextMs);
            return;
        }

        const newSigs = evaluateSignals();
        newSigs.forEach(s=>console.log(`  [NEW][${s.action}] ${s.label} ${s.side}连${s.len}→${s.chase} ${s.pct}%`));

        const seen   = new Set(carryOver.map(s=>`${s.dimId}|${s.side}|${s.len}|${s.action}`));
        const merged = [...carryOver];
        for (const sig of newSigs) {
            const key = `${sig.dimId}|${sig.side}|${sig.len}|${sig.action}`;
            if (!seen.has(key)) {
                merged.push({ ...sig, retryCount:0, totalLost:0, consecutiveLoss:0, recoveryMode:false, nextIssue });
                seen.add(key);
            }
        }

        merged.sort((a,b)=>b.retryCount-a.retryCount||b.pct-a.pct||b.n-a.n);

        const bettedSignals = assignBets(merged);
        db.pendingSignals = bettedSignals.map(s=>({ ...s, nextIssue }));

        if (!bettedSignals.length && !verResults.length) {
            console.log('  [silent] no signals');
        }

        if (verResults.length>0 || bettedSignals.length>0) {
            send(buildMsg(raw, bettedSignals, verResults, nextIssue));
        }

    } else {
        process.stdout.write(`\r[poll] 期${raw.preDrawIssue} → 下期${nextIssue} ${Math.ceil(secsToNext()??0)}s  bal:${fmt(db.balance)}  `);
    }

    setTimeout(poll,nextMs);
}

(async()=>{
    console.log('Dragon Sim Bot');
    console.log(`   Chat: ${CHAT_ID}  Threshold: >=${HIGHLIGHT}%  MIN_N: ${MIN_N}  Starting: ${STARTING_BALANCE}`);
    console.log(`   Ladder: dynamic (base ${getCurrentBase()} @ balance ${fmt(db.balance)})  SplitCap:${SPLIT_BET_CAP}  SmartRecovery@step${SMART_RECOVERY_FROM}  MaxRecoveryRounds:${MAX_RECOVERY_ROUNDS}`);
    console.log(`   Daily: +${DAILY_GROWTH*100}% target  2pm MYT resume  Rebuild every ${REBUILD_EVERY} draws`);
    console.log('');
    try{await init();}catch(e){console.error('[init error]',e.message);process.exit(1);}
    send([
        `🐲 *Dragon Sim Bot 已启动*`,
        `💰 余额: *${STARTING_BALANCE}*  🎯 目标: *${Math.ceil(STARTING_BALANCE*(1+DAILY_GROWTH))}*`,
        `🪜 梯注: ${getCurrentLadder().join('→')} (base ${getCurrentBase()}, 自动升档)`,
        `🔄 智能回本: step${SMART_RECOVERY_FROM}+精确计算 连${MAX_RECOVERY_ROUNDS}次全败→停止`,
        `🔁 每${REBUILD_EVERY}期刷新信号表`,
        `🎯 达标停止，次日2pm MYT恢复`,
        `🛑 硬顶: 亏损${HARD_CAP_LOSS}永久停止`,
    ].join('\n'));
    poll();
})();