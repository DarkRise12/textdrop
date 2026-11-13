const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context={window:{},URL};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/links.js'),'utf8'),context);
const parts=text=>Array.from(context.window.TextdropLinks.parts(text),p=>({...p}));
test('preserves all literal text, line breaks, query strings and punctuation',()=>{
 const text='Ссылка: (https://example.com/a(b)).\nhttp://example.org/?a=1&b=2, https://пример.рф/путь!';
 const segments=parts(text);assert.equal(segments.map(p=>p.text).join(''),text);
 assert.deepEqual(segments.filter(p=>p.href).map(p=>p.text),['https://example.com/a(b)','http://example.org/?a=1&b=2','https://пример.рф/путь']);
 assert(segments.find(p=>p.text==='https://пример.рф/путь').href.startsWith('https://xn--'));
});
test('does not turn scripts, raw HTML, credentials or other protocols into executable markup',()=>{
 for(const text of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','ftp://example.com/a','https://user:password@example.com/','https://example.com\\@evil.example/','<img src=x onerror=alert(1)>','https://']){
  const segments=parts(text);assert.equal(segments.filter(p=>p.href).length,0,text);assert.equal(segments.map(p=>p.text).join(''),text);
 }
 const markup='<a href="https://example.com/">literal</a>';
 assert.equal(parts(markup).map(p=>p.text).join(''),markup);
 assert.deepEqual(parts('https://[::1]/a).').filter(p=>p.href).map(p=>p.href),['https://[::1]/a']);
});
test('handles repeated, adjacent and long links without losing text',()=>{
 for(const text of ['https://one.example https://two.example','«https://example.com»','https://example.com/a))!', 'https://example.com/'+')'.repeat(5000), 'plain text', '']){
  assert.equal(parts(text).map(p=>p.text).join(''),text);
 }
});

test('search matches map Unicode casefold expansions to the original characters',()=>{
 const ranges=(text,query)=>Array.from(context.window.TextdropLinks.ranges(text,query),range=>({...range}));
 assert.deepEqual(ranges('Начало ПРОЕКТ конец','проект'),[{start:7,end:13}]);
 assert.deepEqual(ranges('😀Straße','STRASSE'),[{start:2,end:8}]);
 assert.deepEqual(ranges('ß','s'),[{start:0,end:1}]);
 assert.deepEqual(ranges('ΟΣ ος','οσ'),[{start:0,end:2},{start:3,end:5}]);
 assert.deepEqual(ranges('ﬃ','ffi'),[{start:0,end:1}]);
 assert.deepEqual(ranges('<img src=x>', 'img'),[{start:1,end:4}]);
 assert.deepEqual(ranges('abc',''),[]);
 assert.deepEqual(ranges('a'.repeat(100000),'a'),[{start:0,end:300}]);
});
