import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('artifacts/web/landing.html','utf8');

test('landing inline scripts compile (a syntax error blanks the whole page)',()=>{
  const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  assert.ok(blocks.length>=1,'landing.html is expected to keep its inline script');
  for(const [i,block] of blocks.entries()) assert.doesNotThrow(()=>new vm.Script(block,{filename:`landing.html script ${i}`}),`inline script ${i} must compile`);
});

test('compatibility section lists every wallet provider with a link',()=>{
  assert.ok(html.includes('id="compatibility"'),'the compatibility section is present');
  const m=html.match(/var COMPAT=(\[[\s\S]*?\n  \]);/);
  assert.ok(m,'COMPAT data must be present');
  const groups=vm.runInNewContext(m[1]);
  assert.ok(groups.length>=4,'NWC, API, Lightning Address and self-hosted groups');
  const wallets=groups.flatMap(g=>g.wallets);
  assert.ok(wallets.length>=20,`expected 20+ provider entries, got ${wallets.length}`);
  for(const g of groups){
    assert.ok(g.group&&g.caps,'every group carries a name and capability label');
    for(const w of g.wallets){
      assert.ok(w.name,'every entry has a name');
      if(!w.ghost){
        assert.ok(/^\/media\/compat\/[a-z0-9-]+\.(png|svg|webp)$/.test(w.logo),w.name+' has a logo path');
        assert.ok(/^https:\/\//.test(w.url),w.name+' has an https link');
      }
    }
  }
  assert.ok(wallets.every(w=>!w.tag),'the wall lists only live connections - no "soon" tags, ever');
  assert.ok(wallets.every(w=>!w.caps),'no capability qualifiers needed - every listed wallet connects');
  const ghosts=wallets.filter(w=>w.ghost).map(w=>w.name);
  assert.ok(ghosts.includes('Any NWC wallet'),'the universal NWC tile is present');
  assert.ok(ghosts.includes('Any LUD-21 wallet'),'the universal LUD-21 tile is present');
});
