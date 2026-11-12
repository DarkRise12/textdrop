const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/theme.js'),'utf8');
function load({saved=null,systemDark=false,storageError=false}={}) {
  const state={saved,document:{documentElement:{dataset:{}},querySelector:()=>({content:''})}};
  const context={document:state.document,window:{},localStorage:{getItem(){if(storageError)throw Error();return state.saved;},setItem(key,value){if(storageError)throw Error();state.saved=value;}},matchMedia:()=>({matches:systemDark,addEventListener(event,callback){state.change=callback;}})};
  vm.runInNewContext(source,context);
  state.choose=context.window.setTextdropTheme;
  state.theme=()=>state.document.documentElement.dataset.theme;
  return state;
}
test('system preference is used until an explicit choice is saved',()=>{
  const state=load({systemDark:true});assert.equal(state.theme(),'dark');
  state.change({matches:false});assert.equal(state.theme(),'light');
  state.choose('dark');assert.equal(state.saved,'dark');
  state.change({matches:false});assert.equal(state.theme(),'dark');
  assert.equal(load({saved:state.saved,systemDark:false}).theme(),'dark');
});
test('unavailable storage does not block theme switching',()=>{
  const state=load({storageError:true});assert.equal(state.theme(),'light');
  state.choose('dark');assert.equal(state.theme(),'dark');
});
