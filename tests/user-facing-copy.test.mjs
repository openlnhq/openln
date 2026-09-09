import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('artifacts/web/index.html','utf8');
const dash=/\u2014|&mdash;|&#(?:8212|x2014);/i;
for(const path of ['artifacts/web/landing.html','artifacts/web/index.html'])test(path+' has no em dashes in authored copy or metadata',()=>{
  const text=fs.readFileSync(path,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/<!--[\s\S]*?-->/g,'');
  assert.equal(dash.test(text),false,'Use normal punctuation, including placeholders and dynamic titles');
});
test('payment and API messages are formatted for display without rewriting stored data',()=>{
  const code=source.slice(source.indexOf('const $='),source.indexOf('</script>',source.indexOf('const $=')));
  const nodes=[];
  const context={document:{querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{},setAttribute(){}}),body:{append:n=>nodes.push(n)}},localStorage:{getItem:()=>null},setTimeout:()=>{}};
  vm.createContext(context);
  vm.runInContext(code,context);
  vm.runInContext('toast("Payment processing\u2014do not retry")',context);
  assert.equal(dash.test(nodes[0].textContent),false);
  const technical='https://example.test/card?q=a\u2014b';
  assert.equal(vm.runInContext('esc('+JSON.stringify(technical)+')',context),technical,'HTML escaping must not rewrite payload values');
});
