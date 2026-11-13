/* Top-level, explicitly enabled capture. Never reads form values. */
(()=>{
 'use strict';let last='',busy=false;
 async function capture(){
  if(busy||document.visibilityState==='hidden')return;busy=true;
  try{
   const policy=await chrome.runtime.sendMessage({type:'daylog:POLICY'});
   last=location.href;
   if(!policy?.ok||!policy.captureEnabled)return;
   const excluded=(policy.excludePatterns||[]).some(p=>p.includes('*')?new RegExp('^'+p.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$','i').test(location.href):location.href.toLowerCase().includes(p.toLowerCase()));
   if(excluded)return;
   const root=document.querySelector('article,main,[role="main"]')||document.body;
   const text=String(root?.innerText||'').replace(/\s+/g,' ').trim().slice(0,4000);
   await chrome.runtime.sendMessage({type:'daylog:CAPTURE',payload:{url:location.href,title:document.title,text}});last=location.href;
  }catch{}finally{busy=false;}
 }
 void capture();setTimeout(()=>{void capture();},3000);
 setInterval(()=>{if(location.href!==last)void capture();},2500);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&location.href!==last)void capture();});
})();
