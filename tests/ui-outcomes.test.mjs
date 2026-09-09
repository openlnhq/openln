import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const html=fs.readFileSync('artifacts/web/index.html','utf8');
test('send UI never reports an ambiguous response as paid or permits a duplicate submit',async()=>{
  const source=html.slice(html.indexOf('function sendModal(){'),html.indexOf('/* ---- WALLET CONNECT ---- */'));
  const fields={'#sf':{style:{}},'#sres':{innerHTML:''}};
  const submit={disabled:false};fields['#sf'].querySelector=()=>submit;
  const messages=[];const context={modal:()=>({querySelector:s=>fields[s]}),api:async()=>({status:'pending',pendingTxId:'fixture-pending'}),FormData:class{*[Symbol.iterator](){yield ['bolt11','fixture-invoice']}},esc:String,toast:m=>messages.push(m),setTimeout:()=>{},render:()=>{}};
  vm.createContext(context);vm.runInContext(source+';sendModal()',context);await fields['#sf'].onsubmit({preventDefault(){},target:{}});
  assert.ok(!fields['#sres'].innerHTML.includes('Payment sent'),'An ambiguous send must not say Payment sent');
  assert.match(fields['#sres'].innerHTML,/processing|pending/i);assert.match(fields['#sres'].innerHTML,/not.*pay|not.*retry/i);
});
