'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

const BOT_TOKEN = process.env.SIM_BOT_TOKEN || 'YOUR_SIM_BOT_TOKEN_HERE';
const CHAT_ID   = process.env.SIM_CHAT_ID   || 'YOUR_SIM_CHAT_ID_HERE';

const API_LATEST  = 'https://api.api168168.com/pks/getLotteryPksInfo.do?lotCode=10037';
const API_HISTORY = 'https://api.api168168.com/pks/getPksHistoryList.do?lotCode=10037';

const HIGHLIGHT        = 70;
const MIN_N            = 7;
const CHECKS           = [2, 3, 4, 5, 6, 7];
const BET_LADDER       = [33, 38, 79, 167, 349, 733, 1400];
const SPLIT_FROM       = 3;    // split from 167 onwards
const RECOVERY_AFTER   = 4;    // consecutive losses → recovery mode
const PAROLI_MULT      = 1.7;  // win multiplier
const PAROLI_CAP       = 3;    // max consecutive wins before reset
const STARTING_BALANCE = 2000;
const HARD_CAP_LOSS    = 2000;
const DAILY_GROWTH     = 0.30;
const RESUME_HOUR_MYT  = 14;   // 2pm MYT
const REBUILD_EVERY    = 25;   // redraw signal table every N draws

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
    for (let i = 0; i < 5; i++) {
        const pos = i;
        dims.push({
            id:`dt${i+1}`, label:`第${i+1}名 龙虎`,
            fn: r => {
                const nums = r.preDrawCode.split(',').map(Number);
                return nums[pos] > nums[9-pos] ? '龙' : '虎';
            }
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
                const pair = dim.id.includes('DS')?['单','双']:dim.id.startsWith('dt')?['龙','虎']:['大','小'];
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
    dayStart      : STARTING_BALANCE,
    dailyTarget   : Math.ceil(STARTING_BALANCE * (1 + DAILY_GROWTH)),
    stopped       : false,
    resumeAt      : null,
};

function evaluateSignals() {
    const active = [];
    const seen   = new Set();
    for (const sig of db.signalTable) {
        const key = `${sig.dimId}|${sig.side}|${sig.len}`;
        if (seen.has(key)) continue;
        const dim = db.dims.find(d=>d.id===sig.dimId);
        if (!dim) continue;
        if (!matchesStreak(db.rawHistory, dim.fn, sig.side, sig.len)) continue;
        seen.add(key);
        active.push(sig);
    }
    return active;
}

function nextResume() {
    const now    = new Date();
    const resume = new Date(now);
    resume.setUTCHours(RESUME_HOUR_MYT - 8, 0, 0, 0); // 2pm MYT = 6am UTC
    if (now >= resume) resume.setUTCDate(resume.getUTCDate() + 1);
    return resume;
}

// Bet sizing: Paroli on wins, martingale on losses, recovery after 4 losses, split from 167
function assignBets(signals) {
    if (signals.length === 0) return [];

    const inRecovery = signals.some(s => (s.consecutiveLoss || 0) >= RECOVERY_AFTER);

    if (inRecovery) {
        // Recovery: exact deficit split across all signals
        const deficit = db.peakBalance - db.balance;
        const pool    = signals;
        const perSig  = Math.ceil((deficit / pool.length) / PAYOUT_RATE);
        return pool.map(s => ({ ...s, betAmt: Math.max(perSig, BET_LADDER[0]), recoveryMode: true }));
    }

    const normal = signals.filter(s => s.retryCount < SPLIT_FROM);
    const high   = signals.filter(s => s.retryCount >= SPLIT_FROM);
    const result = [];

    if (high.length === 0) {
        // Single best signal
        const best = normal.slice().sort((a,b) => b.pct-a.pct || b.n-a.n)[0];
        let amt;
        if ((best.consecutiveWin || 0) > 0 && (best.consecutiveWin || 0) < PAROLI_CAP) {
            // Paroli: last win profit * 1.7
            amt = Math.ceil((best.lastWinProfit || BET_LADDER[0]) * PAROLI_MULT);
        } else {
            amt = BET_LADDER[Math.min(best.retryCount, BET_LADDER.length-1)];
        }
        result.push({ ...best, betAmt: amt });
    } else {
        // High tier: pool all, losses*1.1 split equally, apply paroli per signal
        const pool        = [...high, ...normal];
        const sumLost     = high.reduce((sum, s) => sum + (s.totalLost || 0), 0);
        const totalNeeded = Math.max(sumLost * 1.1, BET_LADDER[SPLIT_FROM]);
        const basePerSig  = Math.ceil(totalNeeded / pool.length);
        for (const sig of pool) {
            let amt = basePerSig;
            if ((sig.consecutiveWin || 0) > 0 && (sig.consecutiveWin || 0) < PAROLI_CAP) {
                amt = Math.ceil((sig.lastWinProfit || basePerSig) * PAROLI_MULT);
            }
            result.push({ ...sig, betAmt: amt });
        }
    }
    return result;
}

const PAYOUT_RATE = 0.96;

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
            const plStr  = v.hit ? `+${fmt(v.betAmt*PAYOUT_RATE)}` : `-${fmt(v.betAmt)}`;
            const mode   = v.recoveryMode?'🔄':v.consecutiveWin>0?`🔥×${v.consecutiveWin}`:'';
            lines.push(`  ${v.hit?'✅':'❌'} ${v.label} 连${v.streakLen}${v.side} 杀${v.chase}⚔️ → 实际 *${v.actual}* (${plStr}) ${mode}`);
        }
    }

    lines.push('');
    const todayPL    = db.balance - db.dayStart;
    const targetLeft = Math.max(0, db.dailyTarget - db.balance);
    lines.push(`💰 余额: *${fmt(db.balance)}* | 峰值: ${fmt(db.peakBalance)} | 谷值: ${fmt(db.troughBalance)}`);
    lines.push(`🎯 今日: ${todayPL>=0?'+':''}${fmt(todayPL)} | 目标: ${fmt(db.dailyTarget)} | 还差: ${fmt(targetLeft)}`);
    lines.push(`📈 总投: ${fmt(db.totalBet)} | 赢: +${fmt(db.totalWin)} | 输: -${fmt(db.totalLoss)} | 净: ${db.totalWin-db.totalLoss>=0?'+':''}${fmt(db.totalWin-db.totalLoss)}`);

    lines.push('');
    lines.push(`\`─────────────────────────\``);
    lines.push(`📌 下批 *#${nextIssue}* 下注:`);
    lines.push('');

    if (db.busted) {
        lines.push(`🛑 *爆仓！已永久停止*`);
    } else if (db.stopped) {
        const mytTime = new Date(db.resumeAt.getTime() + 8*60*60*1000);
        lines.push(`🎯 *今日+30%达成！已停止*`);
        lines.push(`_次日 ${mytTime.toUTCString().slice(5,11)} 2pm MYT 恢复_`);
    } else if (bettedSignals.length === 0) {
        lines.push('_暂无信号_');
    } else {
        const totalNextBet = bettedSignals.reduce((sum,s)=>sum+s.betAmt,0);
        const isRecovery   = bettedSignals.some(s=>s.recoveryMode);
        const isParoli     = bettedSignals.some(s=>(s.consecutiveWin||0)>0);
        const highCount    = bettedSignals.filter(s=>s.retryCount>=SPLIT_FROM).length;

        if (isRecovery)      lines.push(`🔄 *回本模式* 目标: ${fmt(db.peakBalance)}`);
        else if (isParoli)   lines.push(`🔥 *Paroli 顺风*`);
        else if (highCount>1)lines.push(`⚠️ _均摊 ×${highCount}_`);
        lines.push('');

        lines.push(`⭐⭐  总注: *${fmt(totalNextBet)}*`);
        lines.push('');
        for (const sig of bettedSignals) {
            const retry = sig.retryCount>0?` ❌×${sig.retryCount}`:'';
            const mode  = sig.recoveryMode?'🔄':(sig.consecutiveWin||0)>0?`🔥×${sig.consecutiveWin}`:'';
            const dim   = db.dims.find(d=>d.id===sig.dimId);
            const sLen  = dim ? currentStreakLen(db.rawHistory, dim.fn, sig.side) : sig.len;
            lines.push(`${sig.label} 连${sLen}${sig.side}${retry} ${mode}`);
            lines.push(`杀${sig.chase}⚔️  下注 *${fmt(sig.betAmt)}*  _(${sig.pct}% n=${sig.n})_`);
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
    console.log(`[init] 信号表: ${db.signalTable.length} 条 (>=${HIGHLIGHT}%)`);
    db.signalTable.forEach(s=>console.log(`  [杀] ${s.label} ${s.side}连${s.len}→${s.chase} ${s.pct}% n=${s.n}`));
}

async function poll() {
    const now = new Date();

    // Check resume
    if (db.stopped && db.resumeAt && now >= db.resumeAt) {
        db.stopped     = false;
        db.resumeAt    = null;
        db.dayStart    = db.balance;
        db.dailyTarget = Math.ceil(db.balance * (1 + DAILY_GROWTH));
        db.pendingSignals = [];
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

        // Rebuild signal table every 25 draws
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

            const profit = hit ? ps.betAmt * PAYOUT_RATE : -ps.betAmt;
            if (hit) {
                db.balance  += ps.betAmt * PAYOUT_RATE;
                db.totalWin += ps.betAmt * PAYOUT_RATE;
            } else {
                db.balance   -= ps.betAmt;
                db.totalLoss += ps.betAmt;
            }
            db.totalBet     += ps.betAmt;
            db.peakBalance   = Math.max(db.peakBalance, db.balance);
            db.troughBalance = Math.min(db.troughBalance, db.balance);
            db.drawsPlayed++;

            const consecutiveWin  = hit ? (ps.consecutiveWin||0)+1 : 0;
            const consecutiveLoss = hit ? 0 : (ps.consecutiveLoss||0)+1;
            verResults.push({ label:ps.label, side:ps.side, streakLen:ps.len, chase:ps.chase, actual, hit, betAmt:ps.betAmt, consecutiveWin:ps.consecutiveWin||0, recoveryMode:ps.recoveryMode||false });
            console.log(`  [${hit?'HIT':'MISS'}] ${ps.label} 杀${ps.chase} → ${actual} | bet:${ps.betAmt} profit:${profit.toFixed(0)} bal:${fmt(db.balance)}`);

            if (db.balance <= STARTING_BALANCE - HARD_CAP_LOSS) {
                db.busted = true;
                console.log('  [BUSTED] 爆仓！');
            }

            if (!db.busted) {
                if (hit && consecutiveWin >= PAROLI_CAP) {
                    // Paroli cap hit — reset fully
                    console.log(`  [PAROLI RESET] ${ps.label} 连赢${consecutiveWin}次 重置`);
                } else {
                    carryOver.push({
                        ...ps,
                        retryCount     : hit ? 0 : ps.retryCount+1,
                        totalLost      : hit ? 0 : (ps.totalLost||0)+ps.betAmt,
                        consecutiveLoss,
                        consecutiveWin,
                        lastWinProfit  : hit ? ps.betAmt * PAYOUT_RATE : 0,
                        recoveryMode   : false,
                        nextIssue,
                    });
                }
            }
        }

        if (db.busted) {
            send(buildMsg(raw, [], verResults, nextIssue));
            setTimeout(poll,nextMs);
            return;
        }

        // Daily target check
        if (db.balance >= db.dailyTarget) {
            db.stopped  = true;
            db.resumeAt = nextResume();
            console.log(`  [TARGET] +30%达成! 余额:${fmt(db.balance)} 次日2pm MYT恢复`);
            send(buildMsg(raw, [], verResults, nextIssue));
            setTimeout(poll,nextMs);
            return;
        }

        // New signals
        const newSigs = evaluateSignals();
        newSigs.forEach(s=>console.log(`  [NEW] ${s.label} ${s.side}连${s.len}→${s.chase} ${s.pct}%`));

        const seen   = new Set(carryOver.map(s=>`${s.dimId}|${s.side}|${s.len}`));
        const merged = [...carryOver];
        for (const sig of newSigs) {
            const key = `${sig.dimId}|${sig.side}|${sig.len}`;
            if (!seen.has(key)) {
                merged.push({ ...sig, retryCount:0, totalLost:0, consecutiveLoss:0, consecutiveWin:0, lastWinProfit:0, recoveryMode:false, nextIssue });
                seen.add(key);
            }
        }

        merged.sort((a,b)=>b.retryCount-a.retryCount||b.consecutiveWin-a.consecutiveWin||b.pct-a.pct||b.n-a.n);

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
    console.log('Dragon Sim Bot (Aggressive B)');
    console.log(`   Chat: ${CHAT_ID}  Threshold: >=${HIGHLIGHT}%  Starting: ${STARTING_BALANCE}`);
    console.log(`   Ladder: ${BET_LADDER.join('>')}  Split@idx${SPLIT_FROM}(${BET_LADDER[SPLIT_FROM]})`);
    console.log(`   Paroli: x${PAROLI_MULT} cap ${PAROLI_CAP}  Recovery after ${RECOVERY_AFTER} losses`);
    console.log(`   Daily: +${DAILY_GROWTH*100}% target  Resume 2pm MYT  Rebuild every ${REBUILD_EVERY} draws`);
    console.log('');
    try{await init();}catch(e){console.error('[init error]',e.message);process.exit(1);}
    send([
        `🐲 *Dragon Sim Bot 已启动*`,
        `💰 余额: *${STARTING_BALANCE}*  🎯 目标: *${Math.ceil(STARTING_BALANCE*(1+DAILY_GROWTH))}*`,
        `🪜 梯注: ${BET_LADDER.join('→')}  分拆@${BET_LADDER[SPLIT_FROM]}`,
        `🔥 Paroli ×${PAROLI_MULT} 最多${PAROLI_CAP}连赢`,
        `🔄 连败${RECOVERY_AFTER}次→回本模式`,
        `🔁 每${REBUILD_EVERY}期刷新信号表`,
        `🎯 达标停止，次日2pm MYT恢复`,
        `🛑 硬顶: 亏损${HARD_CAP_LOSS}永久停止`,
    ].join('\n'));
    poll();
})();