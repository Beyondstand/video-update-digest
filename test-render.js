"use strict";
(async () => {
  try {
    const canvas=document.createElement("canvas");canvas.width=1280;canvas.height=720;
    const c=canvas.getContext("2d");c.fillStyle="#0b3d66";c.fillRect(0,0,1280,720);
    c.fillStyle="#ff8c1a";c.fillRect(80,490,1120,14);c.fillStyle="#fff";c.font='48px "Microsoft YaHei", sans-serif';
    c.fillText("视频更新速递 · 测试画面",90,300);c.font='26px "Microsoft YaHei", sans-serif';c.fillText("此图由本地 Canvas 生成，无外部素材依赖",90,365);
    const meta={id:"BVTEST",title:"报告预览：中文、截图、长表格与安全文本",owner:"测试作者",platformLabel:"B站",duration:180,url:"https://www.bilibili.com/video/BVTEST/",sourceNote:"这是本地合成预览，不代表真实视频内容。"};
    const out={reportHtml:'<h2>这个视频在讲什么</h2><p>检查标题、正文、截图和脚注的排版。文本中的 &lt;script&gt; 应显示为文字。</p><!--FIG1--><h2>讲解脉络</h2>'+Array.from({length:16},(_,i)=>`<p><span class="ts">[${String(i).padStart(2,"0")}:00]</span>第 ${i+1} 段：验证连续内容在不同窗口宽度下完整布局，结尾不应被遗漏。</p>`).join('')+'<h2>内容边界</h2><table><tr><th>检查项</th><th>预期</th></tr><tr><td>宽窗口</td><td>裁出报告区域，文字不变形</td></tr><tr><td>窄窗口</td><td>正文重新布局</td></tr></table><h2>结束标记</h2><p>END-OF-REPORT</p>',summary:"本地渲染预览",review:"用于验证排版",captions:["本地合成画面"]};
    window.__dims=await BWM.setContent(buildReportHtml(meta,out,[{t:60,dataUrl:canvas.toDataURL("image/png")}]),900);
  } catch(error) { window.__err=error.message;document.body.textContent=`预览失败：${error.message}`; }
  finally { window.__done=true; }
})();
