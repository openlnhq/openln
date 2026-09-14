// Explicit offline NWC boundary for integration tests. Never opens a socket.
import { createHash } from 'node:crypto';
import { getPublicKey, signAsync, verifyAsync } from '@noble/secp256k1';

const chars='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const key=Uint8Array.from([...Array(31).fill(0),1]);
function words(bytes){let acc=0,bits=0;const out=[];for(const b of bytes){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;out.push((acc>>>bits)&31);}}if(bits)out.push((acc<<(5-bits))&31);return out;}
function bytes(input){let acc=0,bits=0;const out=[];for(const w of input){acc=(acc<<5)|w;bits+=5;while(bits>=8){bits-=8;out.push((acc>>>bits)&255);}}if(bits)out.push((acc<<(8-bits))&255);return Buffer.from(out);}
function field(type,input){const w=words(input);return [chars.indexOf(type),w.length>>>5,w.length&31,...w];}
function polymod(values){const gen=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let chk=1;for(const v of values){const top=chk>>>25;chk=((chk&0x1ffffff)<<5)^v;for(let i=0;i<5;i++)if((top>>>i)&1)chk^=gen[i];}return chk>>>0;}
let next=0;
export const walletFixture={pays:[],mints:[],invoices:new Map(),outcomes:new Map(),pay:null,mint:null,lookups:0,reset(){this.pays=[];this.mints=[];this.pay=null;this.mint=null;this.lookups=0;}};
export async function invoiceFixture(amountSats=100){
 const preimage=createHash('sha256').update('openln-qa-invoice-'+(++next)).digest('hex');
 const paymentHash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
 const hrp='lnbc'+(amountSats*10)+'n';let stamp=Math.floor(Date.now()/1000);const timestamp=Array(7).fill(0);for(let i=6;i>=0;i--){timestamp[i]=stamp%32;stamp=Math.floor(stamp/32);}
 const data=[...timestamp,...field('p',Buffer.from(paymentHash,'hex')),...field('d',Buffer.from('Offline RIC QA invoice')),...field('n',getPublicKey(key))];
 const digest=createHash('sha256').update(Buffer.concat([Buffer.from(hrp),bytes(data)])).digest();
 const signature=await signAsync(digest,key,{prehash:false,format:'recovered'});
 if(!await verifyAsync(signature.subarray(1),digest,getPublicKey(key),{prehash:false}))throw Error('Fixture signature verification failed');
 const sig=Buffer.concat([signature.subarray(1),signature.subarray(0,1)]);const full=[...data,...words(sig)];
 const expanded=[...hrp].map(c=>c.charCodeAt(0)>>>5).concat(0,[...hrp].map(c=>c.charCodeAt(0)&31));
 const mod=polymod([...expanded,...full,0,0,0,0,0,0])^1;const checksum=Array.from({length:6},(_,i)=>(mod>>>(5*(5-i)))&31);
 const invoice=hrp+'1'+[...full,...checksum].map(w=>chars[w]).join('');
 const fixture={invoice,payment_hash:paymentHash,preimage,amount:amountSats*1000};walletFixture.invoices.set(invoice,fixture);return fixture;
}
export class OfflineNWCClient{
 constructor({nostrWalletConnectUrl}){this.wallet=nostrWalletConnectUrl;}
 close(){}
 async makeInvoice(params){walletFixture.mints.push(params);if(walletFixture.mint)return walletFixture.mint(params,this);return invoiceFixture(params.amount/1000);}
 async payInvoice({invoice}){const fixture=walletFixture.invoices.get(invoice);if(!fixture)throw Error('Unregistered offline invoice');walletFixture.pays.push({invoice,wallet:this.wallet});if(walletFixture.pay)return walletFixture.pay(fixture,this);walletFixture.outcomes.set(this.wallet+fixture.payment_hash,{...fixture,type:'outgoing',state:'settled',settled_at:Math.floor(Date.now()/1000),fees_paid:0});return {preimage:fixture.preimage,fees_paid:0};}
 async lookupInvoice(params){walletFixture.lookups++;const hash=params.payment_hash||walletFixture.invoices.get(params.invoice)?.payment_hash;const row=walletFixture.outcomes.get(this.wallet+hash);if(row)return row;const err=Error('No record');err.code='NOT_FOUND';throw err;}
 async listTransactions(){return {transactions:[...walletFixture.outcomes.entries()].filter(([k])=>k.startsWith(this.wallet)).map(([,v])=>v)};}
 async getBalance(){return {balance:1000000000};}
 async getWalletServiceInfo(){return {capabilities:['pay_invoice','make_invoice','lookup_invoice','list_transactions'],notifications:[],encryptions:['nip04']};}
 async getInfo(){return {methods:['pay_invoice','make_invoice','lookup_invoice','list_transactions']};}
}
