const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const cfg={from:'writer@example.test',to:'reader@example.test',smtpHost:'smtp.example.test',smtpPort:'465',smtpPass:'test-smtp-authorization',relayUrl:'https://relay.example.test',relayKey:'test-relay-key-at-least-24-chars'};
function setup(){
 const ctx=vm.createContext({TextEncoder,URL,btoa,atob,Response,AbortController,setTimeout,clearTimeout,fetch:async()=>{throw Error('Unexpected network');}});
 vm.runInContext(fs.readFileSync(path.join(root,'common.js'),'utf8'),ctx);
 vm.runInContext(fs.readFileSync(path.join(root,'daylog/mail.js'),'utf8'),ctx);return ctx;
}
function contentPart(mime,type){
 const marker='Content-Type: '+type;
 const tail=mime.slice(mime.indexOf(marker)+marker.length);
 return Buffer.from(tail.split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\s/g,''),'base64').toString('utf8');
}
test('daily MIME round-trips Unicode report in both plain text and downloadable markdown',()=>{
 const ctx=setup(),markdown='# 日报 2026-11-08\n\n中文正文 📓\n- 第一项\n- 第二项\n';
 const mime=ctx.DayLogMail.buildMime(cfg,'浏览日报 2026-11-08',markdown,'daily-round-trip');
 assert.equal(contentPart(mime,'text/plain; charset=UTF-8'),markdown);
 assert.equal(contentPart(mime,'text/markdown; charset=UTF-8'),markdown);
 assert.match(mime,/Content-Disposition: attachment; filename="report-2026-11-08\.md"/);
 assert.match(mime,/Content-Type: multipart\/mixed;/);assert.match(mime,/Content-Type: multipart\/alternative;/);
 assert.ok(mime.endsWith('--\r\n'));
});
test('HTML escapes report markup and Unicode subject folding preserves codepoints',()=>{
 const ctx=setup(),subject='每日浏览报告📖'.repeat(40),markdown='<script>steal()</script> <img src=x onerror=steal()> & "test"';
 const mime=ctx.DayLogMail.buildMime(cfg,subject,markdown,'safe-report'),html=contentPart(mime,'text/html; charset=UTF-8');
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));
 const encoded=mime.match(/Subject: ([\s\S]*?)\r\nDate:/)[1].split('\r\n ');
 assert.ok(encoded.every(x=>x.length<=75));
 assert.equal(encoded.map(x=>Buffer.from(x.slice(10,-2),'base64').toString()).join(''),subject);
});
test('header and message identifier injection are rejected or encoded safely',()=>{
 const ctx=setup();
 assert.throws(()=>ctx.DayLogMail.buildMime({...cfg,to:'a@example.test\r\nBcc: b@example.test'},'test','report','safe'),/邮箱/);
 assert.throws(()=>ctx.DayLogMail.buildMime(cfg,'test','report','bad\r\nBcc: x'),/消息 ID/);
 assert.throws(()=>ctx.DayLogMail.buildMime(cfg,'test','report','a'.repeat(81)),/消息 ID/);
 const mime=ctx.DayLogMail.buildMime(cfg,'title\r\nBcc: victim@example.test','report','safe');assert.ok(!mime.includes('\r\nBcc:'));
});
test('send authenticates the existing relay protocol without requiring a model or video author',async()=>{
 const ctx=setup();let request;
 ctx.fetch=async(url,options)=>{request={url,options};return new Response(JSON.stringify({ok:true}),{status:200});};
 assert.equal((await ctx.DayLogMail.send({...cfg,modelKey:'must-not-be-forwarded'},'日报','body','send-test')).smtpAccepted,true);
 assert.equal(request.url,cfg.relayUrl);assert.equal(request.options.headers.Authorization,'Bearer '+cfg.relayKey);
 const body=JSON.parse(request.options.body);assert.equal(body.user,cfg.from);assert.equal(body.pass,cfg.smtpPass);assert.equal(body.port,465);
 assert.deepEqual(Object.keys(body).sort(),['from','host','pass','port','rawMimeBase64','to','user']);assert.ok(!request.options.body.includes('must-not-be-forwarded'));
 assert.match(Buffer.from(body.rawMimeBase64,'base64').toString(),/filename="daily-report\.md"/);
});
test('mail settings validate and normalize without a model, video author or network request',()=>{
 const ctx=setup();const normalized=ctx.DayLogMail.mailSettings({...cfg,from:'writer@163.com',smtpHost:'',smtpPort:587,relayUrl:'https://relay.example.test/'});
 assert.equal(normalized.host,'smtp.163.com');assert.equal(normalized.smtpHost,'smtp.163.com');assert.equal(normalized.port,587);assert.equal(normalized.smtpPort,'587');
 assert.equal(normalized.relayUrl,'https://relay.example.test');assert.equal(normalized.from,'writer@163.com');assert.equal(normalized.to,cfg.to);assert.equal(normalized.smtpPass,cfg.smtpPass);assert.equal(normalized.relayKey,cfg.relayKey);
 assert.equal(normalized.modelApi,undefined);assert.equal(normalized.uid,undefined);
});
test('bad mail configuration and oversized reports fail before any network request',async()=>{
 const ctx=setup();let calls=0;ctx.fetch=async()=>{calls++;throw Error('Must not fetch');};
 for(const invalid of [{relayKey:'short'},{relayUrl:'http://relay.example.test'},{smtpPort:'25'},{smtpPass:'line\r\ninjection'},{smtpHost:'smtp.example.test\r\nX:1'}]){
  await assert.rejects(ctx.DayLogMail.send({...cfg,...invalid},'日报','body','invalid'),error=>error.deliveryUnknown===false);
 }
 await assert.rejects(ctx.DayLogMail.send(cfg,'日报','x'.repeat(4000001),'large'),error=>error.deliveryUnknown===false);
 assert.equal(calls,0);
});
test('definite SMTP rejection permits retry and never exposes arbitrary relay errors',async()=>{
 const ctx=setup();ctx.fetch=async()=>new Response(JSON.stringify({ok:false,deliveryUnknown:false,error:cfg.smtpPass+' '+cfg.relayKey}),{status:502});
 await assert.rejects(ctx.DayLogMail.send(cfg,'日报','body','rejected'),error=>error.deliveryUnknown===false&&!error.message.includes(cfg.smtpPass)&&!error.message.includes(cfg.relayKey));
 ctx.fetch=async()=>new Response(JSON.stringify({ok:false,error:'forbidden'}),{status:403});
 await assert.rejects(ctx.DayLogMail.send(cfg,'日报','body','forbidden'),error=>error.deliveryUnknown===false);
});
test('network disconnect, malformed response and unknown SMTP result require recipient confirmation',async()=>{
 const ctx=setup();
 for(const fetcher of [async()=>{throw Error('diagnostic '+cfg.smtpPass);},async()=>new Response('not JSON'),async()=>new Response(JSON.stringify({ok:false,deliveryUnknown:true}),{status:502}),async()=>new Response(JSON.stringify({ok:false}),{status:502})]){
  ctx.fetch=fetcher;
  await assert.rejects(ctx.DayLogMail.send(cfg,'日报','body','unknown'),error=>error.deliveryUnknown===true&&!error.message.includes(cfg.smtpPass));
 }
});
