import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../artifacts/web/index.html',import.meta.url),'utf8');
const start=html.indexOf('/* ---- ADMIN PAYMENTS');
const end=html.indexOf('\n(function(){',start);
function harness(outcome={status:'cancelled',paymentHash:'a'.repeat(64),message:'Checkout cancelled. RIC can continue.'}){
 const elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,textContent:'',style:{},addEventListener(){},focus(){},querySelectorAll(){return []}});return elements.get(id)};
 const calls=[];
 const detail={invoice:{id:'11111111-1111-4111-8111-111111111111',paymentHash:'a'.repeat(64),amountSats:39,wrapStatus:'created'},actions:{canCancelPayment:true},checkoutStatus:{status:'pending'},timeline:[]};
 const context={console,Date,JSON,URLSearchParams,encodeURIComponent,displayText:String,esc:String,prose:String,fmt:String,ago:String,VIEW:'adminpayments',setInterval:()=>1,clearInterval(){},toast(){},confirm:()=>true,document:{},
  $:s=>el(s),api:async(path,options)=>{calls.push({path,options});if(options?.method==='POST'){if(outcome instanceof Error)throw outcome;return outcome;}return detail},
  modal:markup=>{context.markup=markup;return {querySelector:s=>el(s),addEventListener(){},remove(){context.closed=true}}},
 };
 vm.createContext(context);vm.runInContext(html.slice(start,end),context);
 return {context,el,calls,detail};
}
test('Treasury payment detail renders a manual cancellation control',async()=>{
 const {context,el,detail}=harness();
 await context.admRenderDetail(detail.invoice.id);
 assert.match(el('#admDetailBody').innerHTML,/data-adm-act="cancel"[^>]*>Cancel payment/);
});
test('Cancellation dialog binds exact invoice and hash with explicit reason',async()=>{
 const {context,el,calls,detail}=harness();
 assert.equal(typeof context.admCancelPayment,'function','manual Treasury cancellation must be implemented');
 context.admCancelPayment(detail);
 assert.match(context.markup,/Cancellation reason/);
 assert.match(context.markup,/39/);
 el('#admCancelReason').value='Customer abandoned checkout';
 await el('#admCancelConfirm').onclick();
 const sent=calls.find(c=>c.options?.method==='POST');
 assert.equal(sent.path,`/api/admin/payments/${detail.invoice.id}/cancel`);
 assert.deepEqual(JSON.parse(sent.options.body),{paymentHash:detail.invoice.paymentHash,reason:'Customer abandoned checkout'});
});
test('Empty cancellation reason never submits and pending is not reported cancelled',async()=>{
 const {context,el,calls,detail}=harness({status:'pending',message:'Cancellation requested. Checking payment status.'});
 assert.equal(typeof context.admCancelPayment,'function');context.admCancelPayment(detail);
 await el('#admCancelConfirm').onclick();assert.equal(calls.filter(c=>c.options?.method==='POST').length,0);
 el('#admCancelReason').value='Stuck checkout';await el('#admCancelConfirm').onclick();
 assert.match(el('#admCancelStatus').textContent,/Cancellation requested|pending|Checking/);
 assert.doesNotMatch(el('#admCancelStatus').textContent,/RIC can continue/);
});
test('Treasury detail polling requests cached status, not a blocking wallet roundtrip',async()=>{
 const {context,calls,detail}=harness();await context.admRenderDetail(detail.invoice.id,true);
 assert.equal(calls[0].path,`/api/admin/payments/${detail.invoice.id}?live=0`);
});
