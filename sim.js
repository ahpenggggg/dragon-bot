'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

const BOT_TOKEN = process.env.SIM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CHAT_ID   = process.env.SIM_CHAT_ID   || 'YOUR_CHAT_ID_HERE';

const API_LATEST  = 'https://api.api168168.com/pks/getLotteryPksInfo.do?lotCode=10037';
const API_HISTORY = 'https://api.api168168.com/pks/getPksHistoryList.do?lotCode=10037';

const HIGHLIGHT = 70;
const MIN_N     = 4;
const CHECKS    = [2, 3, 4, 5, 6, 7];

// Martingale ladder — index = retryCount (0=fresh bet)
const BET_LADDER = [22, 25, 52, 110, 230, 483, 922];
// From index 4 (483) onwards, split equally across all active signals
const SPLIT_FROM  = 4;

const STARTING_BALANCE = 2000;

const posLabels = ['冠军','亚军','第三','第四','第五','第六','第七','第八','第九','第十'];

// ── Dimensions (same as main bot) ─────────────────────────────────────────────
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
    const dtFields = ['firstDT','secondDT','thirdDT','fourthDT','fifthDT'];
    for (let i = 0; i < 5; i++) {
        const field = dtFields[i];
        dims.push({
            id:`dt${i+1}`, label:`第${i+1}名 龙虎`,
            fn: r => r[field]===1?'虎':'龙'
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

// ── DB ────────────────────────────────────────────────────────────────────────
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
    // Sim state
    balance       : STARTING_BALANCE,
    totalBet      : 0,
    totalWin      : 0,
    totalLoss     : 0,
    drawsPlayed   : 0,
    peakBalance   : STARTING_BALANCE,
    troughBalance : STARTING_BALANCE,
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

// ── Bet sizing ────────────────────────────────────────────────────────────────
function assignBets(signals) {
    if (signals.length === 0) return [];

    const normal  = signals.filter(s => s.retryCount < SPLIT_FROM);
    const high    = signals.filter(s => s.retryCount >= SPLIT_FROM);

    const result  = [];

    for (const sig of normal) {
        const amt = BET_LADDER[Math.min(sig.retryCount, BET_LADDER.length-1)];
        result.push({ ...sig, betAmt: amt });
    }

    if (high.length > 0) {
        const maxRetry  = Math.max(...high.map(s=>s.retryCount));
        const totalAmt  = BET_LADDER[Math.min(maxRetry, BET_LADDER.length-1)];
        const perSig    = Math.floor(totalAmt / high.length);
        for (const sig of high) {
            result.push({ ...sig, betAmt: perSig });
        }
    }

    return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function secsToNext() {
    if (!db.nextDrawAt) return null;
    return Math.max(0,(db.nextDrawAt-Date.now())/1000);
}
const PAD2 = n=>String(n).padStart(2,' ');
const fmt  = n=>n.toFixed(0);

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN,{polling:false});
function send(text) {
    return bot.sendMessage(CHAT_ID,text,{parse_mode:'Markdown',disable_web_page_preview:true})
              .catch(err=>console.error('[sim][send error]',err.message));
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
        const roundPL = verResults.reduce((sum,v)=>sum+(v.hit?v.betAmt:-v.betAmt),0);
        lines.push('');
        lines.push(`📊 上期验证 (${hits}/${verResults.length} 命中) P&L: ${roundPL>=0?'+':''}${fmt(roundPL)}:`);
        for (const v of verResults) {
            const plStr = v.hit ? `+${fmt(v.betAmt)}` : `-${fmt(v.betAmt)}`;
            lines.push(`  ${v.hit?'✅':'❌'} ${v.label} 连${v.streakLen}${v.side} 杀${v.chase}⚔️ → 实际 *${v.actual}* (${plStr})`);
        }
    }

    lines.push('');
    lines.push(`💰 余额: *${fmt(db.balance)}* | 峰值: ${fmt(db.peakBalance)} | 谷值: ${fmt(db.troughBalance)}`);
    lines.push(`📈 总投: ${fmt(db.totalBet)} | 赢: +${fmt(db.totalWin)} | 输: -${fmt(db.totalLoss)} | 净: ${db.totalWin-db.totalLoss>=0?'+':''}${fmt(db.totalWin-db.totalLoss)}`);

    lines.push('');
    lines.push(`\`─────────────────────────\``);
    lines.push(`📌 下批 *#${nextIssue}* 下注:`);
    lines.push('');

    if (bettedSignals.length === 0) {
        lines.push('_暂无⭐⭐信号_');
    } else {
        const totalNextBet = bettedSignals.reduce((sum,s)=>sum+s.betAmt,0);
        const highCount    = bettedSignals.filter(s=>s.retryCount>=SPLIT_FROM).length;
        if (highCount > 1) {
            lines.push(`⚠️ _高级信号 ×${highCount}，均摊下注_`);
            lines.push('');
        }
        lines.push(`⭐⭐  总注: *${fmt(totalNextBet)}*`);
        lines.push('');
        for (const sig of bettedSignals) {
            const retry = sig.retryCount>0?` ❌×${sig.retryCount}`:'';
            const dim   = db.dims.find(d=>d.id===sig.dimId);
            const sLen  = dim ? currentStreakLen(db.rawHistory, dim.fn, sig.side) : sig.len;
            lines.push(`${sig.label} 连${sLen}${sig.side}${retry}`);
            lines.push(`杀${sig.chase}⚔️  下注 *${fmt(sig.betAmt)}*  _(${sig.pct}% n=${sig.n})_`);
            lines.push('');
        }
    }

    lines.push(`⏳ 下条🐲出末 ⚠️ : \`${nextT}\` (约${secsL}秒后) ⚠️`);
    return lines.join('\n');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    console.log('[sim][init] 加载历史数据...');
    let data;
    for (let attempt=1; attempt<=3; attempt++) {
        try {
            const res = await axios.get(API_HISTORY, {timeout:20_000});
            data = res.data;
            break;
        } catch(e) {
            console.log('[sim][init] attempt '+attempt+' failed: '+e.message);
            if (attempt===3) throw e;
            await new Promise(r=>setTimeout(r,3000));
        }
    }
    if (data.errorCode!==0) throw new Error(data.message);
    db.rawHistory  = data.result.data.slice().reverse();
    db.startIssue  = db.rawHistory[0].preDrawIssue;
    db.lastIssue   = db.rawHistory[db.rawHistory.length-1].preDrawIssue;
    console.log(`[sim][init] ${db.rawHistory.length} 期 (${db.startIssue} → ${db.lastIssue})`);
    db.dims        = buildDimensions();
    db.signalTable = buildSignalTable(db.rawHistory);
    console.log(`[sim][init] ⭐⭐ 信号表: ${db.signalTable.length} 条 (≥${HIGHLIGHT}%)`);
    db.signalTable.forEach(s=>console.log(`  [杀] ${s.label} ${s.side}连${s.len}→${s.chase} ${s.pct}% n=${s.n}`));
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
    const s=secsToNext(), isNear=s!==null&&s<=15, nextMs=isNear?4_000:15_000;
    if (s!==null) {
        if (!db.shownStart&&s>55){console.log('\n[sim][countdown] ▶ 新一期 ~60s');db.shownStart=true;}
        if (!db.shownLast&&s<=30){console.log(`\n[sim][countdown] ⚠️  最后 ${Math.ceil(s)}s`);db.shownLast=true;}
    }

    let raw,nextTime,nextIssue;
    try {
        const {data}=await axios.get(API_LATEST,{timeout:10_000});
        if (data.errorCode!==0) throw new Error(data.message);
        raw=data.result.data; nextTime=raw.drawTime; nextIssue=raw.drawIssue;
    } catch(e){console.error('\n[sim][fetch error]',e.message);setTimeout(poll,nextMs);return;}

    db.nextDrawAt=new Date(nextTime.replace(' ','T'));

    if (raw.preDrawIssue!==db.lastIssue) {
        db.lastIssue=raw.preDrawIssue; db.drawCount++;
        db.shownStart=false; db.shownLast=false;
        console.log(`\n[sim][#${db.drawCount}] 期${raw.preDrawIssue} ${raw.preDrawTime.slice(11,19)}`);

        db.rawHistory.push(raw);
        if (db.rawHistory.length>1000) db.rawHistory.shift();

        const verResults = [];
        const carryOver  = [];

        for (const ps of db.pendingSignals) {
            if (ps.nextIssue !== raw.preDrawIssue) continue;
            const dim    = db.dims.find(d=>d.id===ps.dimId);
            const actual = dim?dim.fn(raw):'?';
            const hit    = actual===ps.chase;

            if (hit) {
                db.balance   += ps.betAmt;
                db.totalWin  += ps.betAmt;
            } else {
                db.balance   -= ps.betAmt;
                db.totalLoss += ps.betAmt;
            }
            db.totalBet      += ps.betAmt;
            db.peakBalance    = Math.max(db.peakBalance, db.balance);
            db.troughBalance  = Math.min(db.troughBalance, db.balance);
            db.drawsPlayed++;

            verResults.push({ label:ps.label, side:ps.side, streakLen:ps.len, chase:ps.chase, actual, hit, betAmt:ps.betAmt });
            console.log(`  [sim][${hit?'HIT✅':'MISS❌'}] ${ps.label} 杀${ps.chase} → ${actual} | bet:${ps.betAmt} bal:${fmt(db.balance)}`);

            if (!hit) {
                carryOver.push({ ...ps, retryCount: ps.retryCount+1, nextIssue });
            }
        }

        const newSigs = evaluateSignals();
        newSigs.forEach(s=>console.log(`  [sim][NEW⭐⭐] ${s.label} ${s.side}连${s.len}→${s.chase} ${s.pct}%`));

        const seen   = new Set(carryOver.map(s=>`${s.dimId}|${s.side}|${s.len}`));
        const merged = [...carryOver];
        for (const sig of newSigs) {
            const key = `${sig.dimId}|${sig.side}|${sig.len}`;
            if (!seen.has(key)) {
                merged.push({ ...sig, retryCount:0, nextIssue });
                seen.add(key);
            }
        }

        merged.sort((a,b)=>b.retryCount-a.retryCount||b.pct-a.pct||b.n-a.n);

        const bettedSignals = assignBets(merged);
        db.pendingSignals = bettedSignals.map(s=>({ ...s, nextIssue }));

        if (!bettedSignals.length && !verResults.length) {
            console.log('  [sim] no signals');
        }

        if (verResults.length>0 || bettedSignals.length>0) {
            send(buildMsg(raw, bettedSignals, verResults, nextIssue));
        }

    } else {
        process.stdout.write(`\r[sim] 期${raw.preDrawIssue} → 下期${nextIssue} ${Math.ceil(secsToNext()??0)}s  bal:${fmt(db.balance)}  `);
    }

    setTimeout(poll,nextMs);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async()=>{
    console.log('🎰  Dragon Sim Bot');
    console.log(`   Chat: ${CHAT_ID}  Threshold: ≥${HIGHLIGHT}%  Starting: ${STARTING_BALANCE}`);
    console.log(`   Ladder: ${BET_LADDER.join(' → ')}  Split from: index ${SPLIT_FROM} (${BET_LADDER[SPLIT_FROM]})`);
    console.log('');
    try{await init();}catch(e){console.error('[sim][init error]',e.message);process.exit(1);}
    send([
        `🎰 *Dragon Sim Bot 已启动*`,
        `💰 起始余额: *${STARTING_BALANCE}*`,
        `🪜 梯注: ${BET_LADDER.join(' → ')}`,
        `⚡ ${BET_LADDER[SPLIT_FROM]}+ 多信号均摊`,
        `⭐⭐ 杀 信号 (≥${HIGHLIGHT}%)`,
    ].join('\n'));
    poll();
})();
