// The send outcome logic must never report an ambiguous send as paid, and must
// not submit a payment twice. Driven directly against the real SEND section in
// a VM with a DOM stub, exactly like the browser would render it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('artifacts/web/index.html','utf8');

test('send UI never reports an ambiguous response as paid or permits a duplicate submit',async()=>{
  const source=html.slice(html.indexOf('/* ---- SEND ---- */'),html.indexOf('/* ---- WALLET CONNECT ---- */'));
  assert.ok(source.includes('sndPay'),'the send section must be present');
  const nodes={};
  let payCalls=0;
  const fake=(sel)=>nodes[sel]||(nodes[sel]={innerHTML:'',style:{},disabled:false,value:'',textContent:'',hidden:false,classList:{toggle(){},add(){},remove(){},contains:()=>false}});
  const context={
    api:async()=>{payCalls++;return{status:'pending',pendingTxId:'fixture-pending'}},
    fmt:(n)=>String(n),fmtFiat:(v,c)=>String(v)+' '+String(c||'').toUpperCase(),esc:String,toast:()=>{},
    document:{createElement:()=>({style:{},classList:{toggle(){}},getContext:()=>({}),width:0,height:0}),querySelector:()=>null,querySelectorAll:()=>[],body:{append(){}}},
    window:{},navigator:{},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    setTimeout:()=>0,clearTimeout:()=>{},URLSearchParams,URL:{createObjectURL:()=>'',revokeObjectURL:()=>{}},
    __fake:fake,
  };
  vm.createContext(context);
  vm.runInContext(source+'\n;snd.root={querySelector:(s)=>__fake(s)};snd.target={kind:"bolt11",bolt11:"fixture-invoice",amountSats:100};snd.invoice={bolt11:"fixture-invoice",amountSats:100};snd.retryStage="";snd.stage="confirm";',context);
  await vm.runInContext('sndPay()',context);
  const sheet=nodes['#sndSheet'];
  assert.ok(sheet&&sheet.innerHTML,'the outcome must render into the sheet');
  assert.ok(!/Payment sent/.test(sheet.innerHTML),'An ambiguous send must not say Payment sent');
  assert.match(sheet.innerHTML,/processing|pending/i);
  assert.match(sheet.innerHTML,/not.*pay|not.*retry/i);
  await vm.runInContext('sndPay()',context);
  assert.equal(payCalls,1,'a fired payment must not be submitted twice');
});
