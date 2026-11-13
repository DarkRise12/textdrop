const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/draft.js'),'utf8'),context);
const Draft=context.window.TextdropDraft;
function storage(){const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
test('reload retains draft text and pending identifier until acknowledgement',()=>{
 const store=storage();const draft=new Draft(store,()=>1000);
 draft.save('Привет 😀',{id:'request-1234567890',text:'Привет 😀'});
 const restored=new Draft(store,()=>2000).load();
 assert.equal(restored.text,'Привет 😀');assert.equal(restored.pending.id,'request-1234567890');
 draft.save('',null);assert.equal(draft.load(),null);
});
test('editing during a send retains the newer text independently of pending content',()=>{
 const draft=new Draft(storage(),()=>1000);
 draft.save('новый текст',{id:'request-1234567890',text:'старый текст'});
 assert.equal(draft.load().text,'новый текст');
 draft.save('новый текст',null);assert.equal(draft.load().text,'новый текст');assert.equal(draft.load().pending,null);
});
test('expired or corrupt data is removed and never restored',()=>{
 const store=storage();const draft=new Draft(store,()=>1000);draft.save('expired',null);
 assert.equal(new Draft(store,()=>1000+7*86400000).load(),null);
 for(const value of ['broken','null',JSON.stringify({text:1,updated:1000}),JSON.stringify({text:'ok',updated:1000,pending:{text:'ok',id:'bad'}})]){
  store.setItem(draft.key,value);assert.equal(draft.load(),null);assert.equal(store.getItem(draft.key),null);
 }
});
test('storage failures propagate so the UI can warn without discarding in-memory text',()=>{
 const draft=new Draft({getItem(){throw Error('blocked')},setItem(){throw Error('quota')},removeItem(){throw Error('blocked')}});
 assert.throws(()=>draft.load());assert.throws(()=>draft.save('text',null));assert.throws(()=>draft.clear());
});

test('file retry metadata survives reload without persisting file bytes and clears on logout',()=>{
 const store=new Map();const storage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
 const source=fs.readFileSync(path.join(__dirname,'../static/draft.js'),'utf8');const env={window:{}};vm.runInNewContext(source,env);
 const pending={name:'same.bin',size:12,lastModified:1000,text:'caption',id:'file-request-123456'};
 const first=new env.window.TextdropDraft(storage,()=>1000);first.save('caption',null,pending);
 const restored=new env.window.TextdropDraft(storage,()=>1001).load();assert.equal(restored.filePending.id,pending.id);assert.equal(restored.filePending.name,'same.bin');
 first.clear();assert.equal(first.load(),null);
});
