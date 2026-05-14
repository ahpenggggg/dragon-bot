'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CHAT_ID   = process.env.CHAT_ID   || 'YOUR_CHAT_ID_HERE';

const API_LATEST  = 'https://api.api168168.com/pks/getLotteryPksInfo.do?lotCode=10037';
const API_HISTORY = 'https://api.api168168.com/pks/getPksHistoryList.do?lotCode=10037';

const HIGHLIGHT = 70;
const MIN_N     = 7;
const CHECKS    = [2, 3, 4, 5, 6, 7];

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
};

// Dynamic evaluation — live streak lookup, fires every draw
const DYNAMIC_HIGHLIGHT = 70; // higher threshold for index bot
const DYNAMIC_MIN_N     = 7;
const DYNAMIC_MIN_STREAK = 3;

function evaluateSignals() {
    const active = [];
    const seen   = new Set();

    for (const dim of db.dims) {
        if (db.rawHistory.length === 0) continue;
        const lastVal   = dim.fn(db.rawHistory[db.rawHistory.length-1]);
        const streakLen = currentStreakLen(db.rawHistory, dim.fn, lastVal);
        if (streakLen < DYNAMIC_MIN_STREAK) continue;

        const vals = db.rawHistory.map(dim.fn);
        const res  = countStreakFollowup(vals, streakLen);
        const s    = res.bySide[lastVal];
        if (!s || s.total < DYNAMIC_MIN_N) continue;

        const pair = dim.id.includes('DS')?['单','双']:['大','小'];
        const opp  = pair.find(x=>x!==lastVal);
        const bPct = Math.round(s.break/s.total*100);

        if (bPct >= DYNAMIC_HIGHLIGHT) {
            const key = `${dim.id}|${lastVal}|${streakLen}`;
            if (!seen.has(key)) {
                seen.add(key);
                active.push({ dimId:dim.id, label:dim.label, side:lastVal, len:streakLen, action:'杀', chase:opp, pct:bPct, n:s.total });
            }
        }
    }

    active.sort((a,b)=>b.pct-a.pct||b.n-a.n);
    return active;
}

function secsToNext() {
    if (!db.nextDrawAt) return null;
    return Math.max(0,(db.nextDrawAt-Date.now())/1000);
}
const PAD2 = n=>String(n).padStart(2,' ');

const bot = new TelegramBot(BOT_TOKEN,{polling:false});
function send(text) {
    return bot.sendMessage(CHAT_ID,text,{parse_mode:'Markdown',disable_web_page_preview:true})
              .catch(err=>console.error('[send error]',err.message));
}

function buildMsg(raw, nextSignals, verResults, nextIssue) {
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
        const hits = verResults.filter(v=>v.hit).length;
        lines.push('');
        lines.push(`📊 上期验证 (${hits}/${verResults.length} 命中):`);
        for (const v of verResults) {
            lines.push(`  ${v.hit?'✅':'❌'} ${v.label} 连${v.streakLen}${v.side} 杀${v.chase}⚔️ → 实际 *${v.actual}*`);
        }
    }

    lines.push('');
    lines.push(`\`─────────────────────────\``);
    lines.push(`📌 下批 *#${nextIssue}* 信号:`);
    lines.push('');

    if (nextSignals.length === 0) {
        lines.push('_暂无⭐⭐信号_');
    } else {
        lines.push(`⭐⭐`);
        lines.push('');
        for (const sig of nextSignals) {
            const dim  = db.dims.find(d=>d.id===sig.dimId);
            const sLen = dim ? currentStreakLen(db.rawHistory, dim.fn, sig.side) : sig.len;
            const retry= sig.retryCount>0?` ❌×${sig.retryCount}`:'';
            lines.push(`${sig.label} 连${sLen}${sig.side}${retry}`);
            lines.push(`杀${sig.chase}⚔️  _(${sig.pct}% n=${sig.n})_`);
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

    if (db.drawCount % 25 === 0 && db.drawCount > 0) {
        db.signalTable = buildSignalTable(db.rawHistory);
    }
}

async function poll() {
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

        if (db.drawCount % 25 === 0) {
            db.signalTable = buildSignalTable(db.rawHistory);
            console.log(`  [REBUILD] 信号表刷新 第${db.drawCount}期: ${db.signalTable.length} 条`);
        }

        const verResults = [];
        const carryOver  = [];

        for (const ps of db.pendingSignals) {
            if (ps.nextIssue !== raw.preDrawIssue) continue;
            const dim    = db.dims.find(d=>d.id===ps.dimId);
            const actual = dim?dim.fn(raw):'?';
            const hit    = actual===ps.chase;
            verResults.push({ label:ps.label, side:ps.side, streakLen:ps.len, chase:ps.chase, actual, hit });
            console.log(`  [${hit?'HIT':'MISS'}] ${ps.label} 杀${ps.chase} → ${actual}`);
            if (!hit) {
                carryOver.push({ ...ps, retryCount: ps.retryCount+1, nextIssue });
            }
        }

        const newSigs = evaluateSignals();
        newSigs.forEach(s=>console.log(`  [NEW] ${s.label} ${s.side}连${s.len}→${s.chase} ${s.pct}%`));

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
        db.pendingSignals = merged;

        if (!merged.length && !verResults.length) {
            console.log('  [silent] no signals');
        }

        if (verResults.length>0 || merged.length>0) {
            send(buildMsg(raw, merged, verResults, nextIssue));
        }

    } else {
        process.stdout.write(`\r[poll] 期${raw.preDrawIssue} → 下期${nextIssue} ${Math.ceil(secsToNext()??0)}s     `);
    }

    setTimeout(poll,nextMs);
}

(async()=>{
    console.log('Dragon Bot v3');
    console.log(`   Chat: ${CHAT_ID}  Threshold: >=${HIGHLIGHT}%`);
    console.log('');
    try{await init();}catch(e){console.error('[init error]',e.message);process.exit(1);}
    send([
        `*Dragon Bot v3 已启动*`,
        `杀 信号 (>=${HIGHLIGHT}%)`,
        `_有信号时推送，失败继续追踪_`,
    ].join('\n'));
    poll();
})();
