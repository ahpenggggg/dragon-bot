'use strict';
const axios = require('axios');
const API_HISTORY = 'https://api.api168168.com/pks/getPksHistoryList.do?lotCode=10037';
const HIGHLIGHT = 65;

async function fetchHistory() {
    const { data } = await axios.get(API_HISTORY, { timeout: 10_000 });
    if (data.errorCode !== 0) throw new Error(data.message);
    return data.result.data.slice().reverse(); // oldest first
}

function buildDimensions() {
    const dims = [];
    for (let i = 0; i < 10; i++) {
        const pos = i;
        dims.push({
            id: `p${pos+1}DS`, label: `第${pos+1}名 单双`,
            fn: r => { const n = r.preDrawCode.split(',').map(Number)[pos]; return n % 2 !== 0 ? '单' : '双'; }
        });
        dims.push({
            id: `p${pos+1}DX`, label: `第${pos+1}名 大小`,
            fn: r => { const n = r.preDrawCode.split(',').map(Number)[pos]; return n <= 5 ? '小' : '大'; }
        });
    }
    for (let i = 0; i < 5; i++) {
        const pos = i;
        dims.push({
            id: `dt${i+1}`, label: `第${i+1}名 龙虎`,
            fn: r => {
                const nums = r.preDrawCode.split(',').map(Number);
                return nums[pos] < nums[9-pos] ? '龙' : '虎';
            }
        });
    }
    dims.push({ id:'gyDS', label:'冠亚和 单双', fn: r => r.sumFS % 2 !== 0 ? '单' : '双' });
    dims.push({ id:'gyDX', label:'冠亚和 大小', fn: r => r.sumFS < 12 ? '小' : '大' });
    return dims;
}

// ── Core analysis ─────────────────────────────────────────────────────────────
// For each dimension and each (streakLen, nextLen) combo, count:
//   continue: next draw is same side
//   break:    next draw is different side
//
// Questions to answer:
//   Q1: 2连 → 3连 (continue) vs break  (2连后续)
//   Q2: 5连 → 6连 (continue) vs break  (5连后续)
//   Q3: 3连 → break? 4连 → break? 5连 → break?  (N连后断的概率)

function countStreakFollowup(vals, streakLen) {
    // Collect all cases where exactly streakLen consecutive same side appears
    // and record what the NEXT draw was
    const results = { continue: 0, break: 0, bySide: {} };

    for (let i = streakLen; i < vals.length; i++) {
        const window = vals.slice(i - streakLen, i);
        const side   = window[0];
        if (!window.every(v => v === side)) continue;
        // Ensure it's exactly streakLen (not longer)
        const before = vals[i - streakLen - 1];
        if (before === side) continue;

        const next = vals[i];
        const cont = next === side;
        if (cont) results.continue++; else results.break++;

        if (!results.bySide[side]) results.bySide[side] = { continue:0, break:0 };
        if (cont) results.bySide[side].continue++; else results.bySide[side].break++;
    }
    return results;
}

function pct(n, total) {
    return total === 0 ? 'N/A  ' : `${Math.round(n/total*100)}%`.padStart(5);
}

function star(pctNum) {
    return pctNum >= 65 ? ' ⭐⭐' : '';
}

function analyse(records) {
    const dims = buildDimensions();
    const n    = records.length;
    const SEP  = '─'.repeat(70);

    console.log('');
    console.log('168极速赛车 — 续的规律分析');
    console.log(`数据: ${records[0].preDrawIssue} → ${records[n-1].preDrawIssue}  (共 ${n} 期)`);
    console.log(SEP);

    // We check these streak lengths
    const CHECKS = [
        { len: 2,  q: '2连后→3连(续) vs 断' },
        { len: 3,  q: '3连后→4连(续) vs 断' },
        { len: 4,  q: '4连后→5连(续) vs 断' },
        { len: 5,  q: '5连后→6连(续) vs 断' },
        { len: 6,  q: '6连后→7连(续) vs 断' },
        { len: 7,  q: '7连后→8连(续) vs 断' },
    ];

    // Summary collectors
    const summaryHigh = []; // entries with >=60% in either direction

    for (const dim of dims) {
        const vals = records.map(dim.fn);
        const rows = [];

        for (const { len, q } of CHECKS) {
            const res   = countStreakFollowup(vals, len);
            const total = res.continue + res.break;
            if (total < 3) continue;

            const cPct = total > 0 ? Math.round(res.continue / total * 100) : 0;
            const bPct = 100 - cPct;
            const winner = cPct >= bPct ? `续${cPct}%${star(cPct)}` : `断${bPct}%${star(bPct)}`;

            rows.push(`  ${String(len)+'连后'}: 续${pct(res.continue,total)} 断${pct(res.break,total)}  (共${total}次) → ${winner}`);

            // Per-side breakdown
            for (const [side, s] of Object.entries(res.bySide)) {
                const st = s.continue + s.break;
                if (st < 3) continue;
                const scPct = Math.round(s.continue / st * 100);
                const sbPct = 100 - scPct;

                // Collect for summary
                if (scPct >= HIGHLIGHT) summaryHigh.push({ dim: dim.label, side, len, action:'续', pct: scPct, n: st });
                // cont mode — skip 断

                rows.push(`    [${side}连${len}后] 续${pct(s.continue,st)}${star(scPct)} 断${pct(s.break,st)}${star(sbPct)} (共${st}次)`);
            }
        }

        if (rows.length > 0) {
            console.log(`\n【${dim.label}】`);
            rows.forEach(r => console.log(r));
        }
    }

    // ── Overall summary across ALL dims ─────────────────────────────────────
    console.log('\n' + SEP);
    console.log('【整体概率汇总 — 所有维度合并】\n');
    console.log('  连数    续(合计)    断(合计)    样本    优势');
    console.log('  ' + '─'.repeat(50));

    for (const { len } of CHECKS) {
        let totalCont = 0, totalBreak = 0;
        for (const dim of dims) {
            const vals = records.map(dim.fn);
            const res  = countStreakFollowup(vals, len);
            totalCont  += res.continue;
            totalBreak += res.break;
        }
        const total  = totalCont + totalBreak;
        if (total === 0) continue;
        const cPct   = Math.round(totalCont  / total * 100);
        const bPct   = 100 - cPct;
        const edge   = cPct >= bPct
            ? `续 ${cPct}%${cPct >= 65 ? ' ⭐⭐' : ''}`
            : `断 ${bPct}%${bPct >= 65 ? ' ⭐⭐' : ''}`;
        console.log(
            `  ${(len+'连后').padEnd(6)}  续${String(cPct+'%').padStart(5)}      断${String(bPct+'%').padStart(5)}    ${String(total).padStart(5)}    ${edge}`
        );
    }

    // ── High probability summary ──────────────────────────────────────────────
    console.log('\n' + SEP);
    console.log('【高概率汇总 ≥60%】\n');

    if (summaryHigh.length === 0) {
        console.log('  暂无 ≥60% 项目');
    } else {
        // Group by streak length desc, then position, then dim type
        function posOrder(label) { const m = label.match(/第(\d+)名/); return m ? parseInt(m[1]) : 99; }
        function dimOrder(label) {
            if (label.includes('大小')) return 0;
            if (label.includes('龙虎')) return 1;
            return 2;
        }

        function sortItems(items) {
            items.sort((a,b) =>
                posOrder(a.dim) - posOrder(b.dim) ||
                dimOrder(a.dim) - dimOrder(b.dim) ||
                a.len - b.len ||
                b.pct - a.pct
            );
        }
        const tier1 = summaryHigh.filter(h => h.pct >= 70);
        const tier2 = summaryHigh.filter(h => h.pct >= 60 && h.pct < 70);
        sortItems(tier1);
        sortItems(tier2);
        if (tier1.length > 0) {
            console.log('  ── ⭐⭐ ≥70% ──');
            for (const h of tier1) {
                console.log(`  ⭐⭐ ${h.dim} ${h.side}连${h.len}→${h.action}  ${h.pct}%  (${h.n}次样本)`);
            }
            console.log('');
        }
        if (tier2.length > 0) {
            console.log('  ── ⭐ 60-69% ──');
            for (const h of tier2) {
                console.log(`  ⭐  ${h.dim} ${h.side}连${h.len}→${h.action}  ${h.pct}%  (${h.n}次样本)`);
            }
            console.log('');
        }
    }

    console.log(SEP);
    console.log(`注: 基于 ${n} 期数据，仅供参考\n`);
}

(async () => {
    try {
        console.log('正在获取数据...');
        const records = await fetchHistory();
        analyse(records);
    } catch (e) {
        console.error('错误:', e.message);
    }
})();
