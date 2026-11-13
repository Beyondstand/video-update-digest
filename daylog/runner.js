'use strict';
(async()=>{try{const query=new URL(location.href).searchParams;await DayLogEngine.run(query.get('day'),query.get('mode')==='mail'?'mail':'generate',query.get('confirm')==='true');}catch(error){document.getElementById('status').textContent=error.message;}finally{const tab=await chrome.tabs.getCurrent();if(tab)await chrome.tabs.remove(tab.id).catch(()=>{});}})();
