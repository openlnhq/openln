import test from 'node:test';
import assert from 'node:assert/strict';
import {getBtcPriceFor,getSupportedCurrencies,applyRateModifier} from '../dist/core/money/price.js';

test('Binance conversion never labels a USD quote as ZAR when FX is unavailable',async(t)=>{
  // Explicit upstream-failure fixture, not live pricing evidence.
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('binance')?new Response(JSON.stringify({price:'60000'}),{status:200}):new Response('{}',{status:503}));
  const rate=await getBtcPriceFor('zar','binance');assert.equal(rate,0,'Missing ZAR FX must be unavailable, not BTC/USD returned as ZAR');
});

test('offline currency choices retain ZAR and THB and BTC has an exact base rate',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:503}));
  const currencies=await getSupportedCurrencies();assert.ok(currencies.includes('zar'));assert.ok(currencies.includes('thb'));
  assert.equal(await getBtcPriceFor('btc'),1);
});
