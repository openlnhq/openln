// Signed, offline BOLT11 fixtures with explicit timestamps and expiry tags.
import {createHash, randomBytes} from 'node:crypto';
import {getPublicKey, signAsync, verifyAsync} from '@noble/secp256k1';
const chars='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const key=Uint8Array.from([...Array(31).fill(0),1]);
function words(bytes){let acc=0,bits=0;const out=[];for(const b of bytes){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;out.push((acc>>>bits)&31);}}if(bits)out.push((acc<<(5-bits))&31);return out;}
function bytes(input){let acc=0,bits=0;const out=[];for(const w of input){acc=(acc<<5)|w;bits+=5;while(bits>=8){bits-=8;out.push((acc>>>bits)&255);}}if(bits)out.push((acc<<(8-bits))&255);return Buffer.from(out);}
function integer(n){const out=[];do{out.unshift(n%32);n=Math.floor(n/32);}while(n);return out;}
function field(tag,data){return [chars.indexOf(tag),data.length>>>5,data.length&31,...data];}
function polymod(values){const gen=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let chk=1;for(const v of values){const top=chk>>>25;chk=((chk&0x1ffffff)<<5)^v;for(let i=0;i<5;i++)if((top>>>i)&1)chk^=gen[i];}return chk>>>0;}
export async function expiryInvoice({createdAt=Math.floor(Date.now()/1000),expiry,amountSats=100,extraTags=[]}={}) {
  const preimage=randomBytes(32).toString('hex'), payment_hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
  const hrp='lnbc'+(amountSats*10)+'n';
  const stamp=integer(createdAt);while(stamp.length<7)stamp.unshift(0);
  const data=[...stamp,...field('p',words(Buffer.from(payment_hash,'hex'))),...field('d',words(Buffer.from('Offline RIC expiry QA'))),...field('n',words(getPublicKey(key))),
    ...(expiry===undefined?[]:field('x',integer(expiry))),...extraTags.flatMap(([tag,data])=>field(tag,data))];
  const digest=createHash('sha256').update(Buffer.concat([Buffer.from(hrp),bytes(data)])).digest();
  const signature=await signAsync(digest,key,{prehash:false,format:'recovered'});
  if(!await verifyAsync(signature.subarray(1),digest,getPublicKey(key),{prehash:false}))throw Error('Fixture signature verification failed');
  const full=[...data,...words(Buffer.concat([signature.subarray(1),signature.subarray(0,1)]))];
  const expanded=[...hrp].map(c=>c.charCodeAt(0)>>>5).concat(0,[...hrp].map(c=>c.charCodeAt(0)&31));
  const mod=polymod([...expanded,...full,0,0,0,0,0,0])^1;
  const checksum=Array.from({length:6},(_,i)=>(mod>>>(5*(5-i)))&31);
  return {invoice:hrp+'1'+[...full,...checksum].map(w=>chars[w]).join(''),payment_hash,preimage,createdAt,expiresAt:createdAt+(expiry??3600)};
}
