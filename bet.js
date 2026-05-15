'use strict';
require('dotenv').config();
const axios = require('axios');

const SITE_BASE = `https://${process.env.SITE_HOST || '0348751692-kb.tcr195uhyru.com'}`;
const LOTTERY   = 'PK10JSC';

// Session cookies — updatable at runtime via /session command
let sessionCookies = {
    JSESSIONID: process.env.SITE_JSESSIONID || '',
    token      : process.env.SITE_TOKEN      || '',
};

function updateSession(jsessionid, token) {
    sessionCookies.JSESSIONID = jsessionid;
    sessionCookies.token      = token;
    console.log(`[bet] Session updated: JSESSIONID=${jsessionid.slice(0,8)}...`);
}

function getCookieHeader() {
    return [
        `JSESSIONID=${sessionCookies.JSESSIONID}`,
        `token=${sessionCookies.token}`,
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
    // dimId format: p6DS, p7DX, p10DS etc
    const isDS = sig.dimId.endsWith('DS');
    const isDX = sig.dimId.endsWith('DX');
    const pos  = parseInt(sig.dimId.slice(1, sig.dimId.length - 2)); // strip leading 'p' and trailing 'DS'/'DX'

    console.log(`[bet] signalToGame: dimId=${sig.dimId} pos=${pos} isDS=${isDS} isDX=${isDX} chase=${sig.chase}`);

    if (isDS) {
        const contents = sig.chase === '单' ? 'S' : 'D';
        console.log(`[bet] → game=DS${pos} contents=${contents} key=DS${pos}_${contents}`);
        return { game: `DS${pos}`, contents, title: `第${pos}名` };
    } else if (isDX) {
        const contents = sig.chase === '大' ? 'D' : 'X';
        console.log(`[bet] → game=DX${pos} contents=${contents} key=DX${pos}_${contents}`);
        return { game: `DX${pos}`, contents, title: `第${pos}名` };
    }
    console.log(`[bet] → NO MATCH for dimId=${sig.dimId}`);
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
    const games = [
        'DX1','DX2','DX3','DX4','DX5','DX6','DX7','DX8','DX9','DX10',
        'DS1','DS2','DS3','DS4','DS5','DS6','DS7','DS8','DS9','DS10',
        'GDX','GDS','LH1','LH2','LH3','LH4','LH5',
        'B1','B2','B3','B4','B5','B6','B7','B8','B9','B10',
        'GYH','DLDH','XYLH','XYLH8',
    ].join(',');
    const res = await axios.get(`${SITE_BASE}/member/odds`, {
        params : { lottery: LOTTERY, games },
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

    console.log('[bet] Odds response type:', typeof odds);
    console.log('[bet] Odds keys:', Object.keys(odds||{}).filter(k => k.startsWith('DS') || k.startsWith('DX')).join(', '));
    console.log('[bet] Full odds sample:', JSON.stringify(odds).slice(0, 200));

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

module.exports = { placeBets, fetchPeriod, fetchBalance, testSession, updateSession };
