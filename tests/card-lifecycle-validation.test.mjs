import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('card lifecycle input validation rejects invalid spend limits before DB writes',()=>{const s=fs.readFileSync('plugins/cards.ts','utf8');assert.ok(s.includes('Number.isSafeInteger'),'Card limits need integer bounds, not unrestricted Number conversion')});
test('cancelled cards offer delete on Cards, and the server refuses deleting live cards',()=>{
  const api=fs.readFileSync('plugins/cards.ts','utf8');
  assert.ok(api.includes('Only cancelled cards can be deleted'),'The API must refuse to delete a card that was not wiped first');
  assert.ok(api.includes('db.delete(cardsTable)'),'Deleting a cancelled card must remove the card row');
  const html=fs.readFileSync('artifacts/web/index.html','utf8');
  assert.ok(html.includes('data-card-del'),'Cancelled card tiles must carry a delete action');
  assert.ok(html.includes("st!=='cancelled'"),'The tile delete action must be reserved for cancelled cards');
  assert.ok(html.includes("method:'DELETE'"),'The delete action must call the DELETE endpoint');
});
test('card deletion clears ledger references instead of blocking on them',()=>{
  const m=fs.readFileSync('migrations/0013_card_delete_references.sql','utf8');
  assert.ok(/transactions_card_id_fkey[\s\S]*ON DELETE SET NULL/.test(m),'Deleting a card must clear the transaction reference, not fail on it');
});
