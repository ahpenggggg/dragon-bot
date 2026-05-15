'use strict';
require('dotenv').config();
const axios = require('axios');

const SITE_BASE = `https://${process.env.SITE_HOST || '0348751692-kb.tcr195uhyru.com'}`;
const LOTTERY   = 'PK10JSC';

// Session cookies — set via env vars, refresh manually on expiry
// SITE_JSESSIONID and SITE_TOKEN from .env
function getCookieHeader() {
    return [
        `JSESSIONID=${process.env.SITE_JSESSIONID}`,
        `token=${process.env.SITE_TOKEN}`,
        `lang=zh_CN`,
        `defaultLT=${LOTTERY}`,
    ].join('; ');
}

const HEADERS = {
    'Content-Type' : 'application/json',
    'Referer'      : `${SITE_BASE}/`,
    'Origin'       : SITE_BASE,
};

// Map sim signal → site game code + content
// dimId: p{pos}DS or p{pos}DX
// chase: 单/双/大/小
function signalToGame(sig) {
    const pos = parseInt(sig.dimId.replace('p','').replace('DS','').replace('DX',''));
    const isDS = sig.dimId.includes('DS');
    const isDX = sig.dimId.includes('DX');

    if (isDS) {
        return {
            game    : `DS${pos}`,
            contents: sig.chase === '单' ? 'S' : 'D',
            title   : `第${pos}名`,
        };
    } else if (isDX) {
        return {
            game    : `DX${pos}`,
            contents: sig.chase === '大' ? 'D' : 'X',
            title   : `第${pos}名`,
        };
    }
    return null;
}

// Fetch current draw number and odds from site
async function fetchPeriod() {
    const res = await axios.get(`${SITE_BASE}/member/period`, {
        params : { lottery: LOTTERY, games: 'DS1,DS2,DS3,DS4,DS5,DS6,DS7,DS8,DS9,DS10,DX1,DX2,DX3,DX4,DX5,DX6,DX7,DX8,DX9,DX10' },
        headers: { ...HEADERS, Cookie: getCookieHeader() },
        timeout: 10_000,
    });
    return res.data;
}

async function fetchOdds() {
    const res = await axios.get(`${SITE_BASE}/member/odds`, {
        params : { lottery: LOTTERY, games: 'DS1,DS2,DS3,DS4,DS5,DS6,DS7,DS8,DS9,DS10,DX1,DX2,DX3,DX4,DX5,DX6,DX7,DX8,DX9,DX10' },
        headers: { ...HEADERS, Cookie: getCookieHeader() },
        timeout: 10_000,
    });
    return res.data;
}

async function fetchBalance() {
    const res = await axios.get(`${SITE_BASE}/member/accounts`, {
        headers: { ...HEADERS, Cookie: getCookieHeader() },
        timeout: 10_000,
    });
    return res.data;
}

// Place bets for a list of signals with amounts
// signals: [{ dimId, chase, betAmt, label, ... }]
// drawNumber: current draw number to bet on
async function placeBets(signals, drawNumber) {
    const odds = await fetchOdds();

    const bets = [];
    for (const sig of signals) {
        const mapped = signalToGame(sig);
        if (!mapped) {
            console.log(`[bet] Cannot map signal: ${sig.dimId} ${sig.chase}`);
            continue;
        }
        const oddsKey = `${mapped.game}_${mapped.contents}`;
        const oddsVal = odds[oddsKey];
        if (!oddsVal) {
            console.log(`[bet] No odds found for key: ${oddsKey}`);
            continue;
        }
        bets.push({
            game    : mapped.game,
            contents: mapped.contents,
            amount  : sig.betAmt,
            odds    : oddsVal,
            title   : mapped.title,
        });
    }

    if (bets.length === 0) {
        console.log('[bet] No valid bets to place');
        return { success: false, error: 'No valid bets' };
    }

    const payload = {
        lottery   : LOTTERY,
        drawNumber: String(drawNumber),
        bets,
        fastBets  : false,
        ignore    : false,
    };

    console.log(`[bet] Placing ${bets.length} bet(s) on draw ${drawNumber}:`);
    bets.forEach(b => console.log(`  ${b.game}_${b.contents} x${b.amount} @ ${b.odds}`));

    try {
        const res = await axios.post(`${SITE_BASE}/member/bet`, payload, {
            headers: { ...HEADERS, Cookie: getCookieHeader() },
            timeout: 10_000,
        });
        console.log(`[bet] Response:`, JSON.stringify(res.data));
        return { success: true, data: res.data, bets };
    } catch (err) {
        const errMsg = err.response?.data || err.message;
        console.error(`[bet] Error:`, errMsg);
        return { success: false, error: errMsg };
    }
}

// Test session validity
async function testSession() {
    try {
        const bal = await fetchBalance();
        console.log('[bet] Session OK. Balance data:', JSON.stringify(bal));
        return true;
    } catch (err) {
        console.error('[bet] Session FAILED:', err.message);
        return false;
    }
}

module.exports = { placeBets, fetchPeriod, fetchBalance, testSession };
