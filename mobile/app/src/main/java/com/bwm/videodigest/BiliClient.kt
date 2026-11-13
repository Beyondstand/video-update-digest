package com.bwm.videodigest

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * WebView 页面上下文 fetch —— 与桌面扩展 pageFetch 同构：
 * 带登录 Cookie 在 bilibili.com 域内调 API，绕开 412/-352 风控。
 * 用户在本应用的 WebView 里登录一次 bilibili 即可。
 */
@SuppressLint("SetJavaScriptEnabled")
class BiliClient(private val ctx: Context) {
    private var web: WebView? = null

    suspend fun ensure(): WebView {
        web?.let { return it }
        return suspendCancellableCoroutine { cont ->
            val v = WebView(ctx)
            v.settings.javaScriptEnabled = true
            v.settings.domStorageEnabled = true
            CookieManager.getInstance().setAcceptThirdPartyCookies(v, true)
            v.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    if (cont.isActive) cont.resume(view)
                }
            }
            web = v
            v.loadUrl("https://space.bilibili.com/")
        }
    }

    /** 在页面上下文执行 fetch(url)，返回 {status, text} */
    private suspend fun pageFetch(url: String): JSONObject = withTimeout(30000) {
        suspendCancellableCoroutine { cont ->
            val q = JSONObject.quote(url)
            val js = """(async()=>{try{const r=await fetch($q,{credentials:'include'});const t=await r.text();return JSON.stringify({status:r.status,text:t});}catch(e){return JSON.stringify({status:0,text:'',err:String(e)});}})()"""
            web!!.evaluateJavascript(js) { raw ->
                val unquoted = JSONObject("{\"v\":$raw}").optString("v")
                if (cont.isActive) cont.resume(try { JSONObject(unquoted) } catch (_: Exception) { JSONObject() })
            }
        }
    }

    private suspend fun api(url: String): JSONObject {
        val raw = pageFetch(url)
        val text = raw.optString("text")
        return try {
            JSONObject(text)
        } catch (_: Exception) {
            throw Exception("接口返回异常（HTTP ${raw.optInt("status")}），请确认已在应用内登录 bilibili")
        }
    }

    /** 作者空间 DOM 抓取视频列表（同扩展 fetchVideoList） */
    suspend fun videoList(uid: String): List<Pair<String, String>> {
        ensure()
        web!!.loadUrl("https://space.bilibili.com/$uid/video")
        delay(4000)
        val js = """JSON.stringify([...document.querySelectorAll('a[href*="/video/"]')].map(a=>{const m=(a.getAttribute('href')||'').match(/video\/(BV[0-9A-Za-z]+)/);return m?{id:m[1],title:(a.textContent||'').trim().slice(0,120)}:null;}).filter(Boolean).filter((x,i,arr)=>arr.findIndex(y=>y.id===x.id)===i))"""
        val raw = withTimeout(15000) {
            suspendCancellableCoroutine<String> { cont ->
                web!!.evaluateJavascript(js) { r ->
                    if (cont.isActive) cont.resume(JSONObject("{\"v\":$r}").optString("v"))
                }
            }
        }
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { arr.getJSONObject(it) }
            .map { it.getString("id") to it.optString("title") }
    }

    suspend fun view(bvid: String): JSONObject {
        val j = api("https://api.bilibili.com/x/web-interface/view?bvid=$bvid")
        if (j.optInt("code") != 0) throw Exception("view 接口失败: ${j.optString("message")}")
        return j.getJSONObject("data")
    }

    /** 多轮收集字幕 URL（坑1 轮换），评分选优，返回字幕文本或 null */
    suspend fun subtitle(bvid: String, cid: Long, duration: Int, title: String): String? {
        val urls = linkedSetOf<String>()
        repeat(6) {
            try {
                val j = api("https://api.bilibili.com/x/player/v2?bvid=$bvid&cid=$cid")
                val arr = j.optJSONObject("data")?.optJSONObject("subtitle")?.optJSONArray("subtitles") ?: JSONArray()
                for (i in 0 until arr.length()) {
                    val u = arr.getJSONObject(i).optString("subtitle_url")
                    if (u.isNotEmpty()) urls.add(if (u.startsWith("//")) "https:$u" else u)
                }
            } catch (_: Exception) { /* 限流跳过本轮 */ }
            delay(400)
        }
        if (urls.isEmpty()) return null
        data class Cand(val text: String, val score: Double)
        val cands = mutableListOf<Cand>()
        for (u in urls) {
            try {
                val raw = pageFetch(u).optString("text")
                val body = JSONObject(raw).optJSONArray("body") ?: continue
                val lines = (0 until body.length()).map { body.getJSONObject(it) }
                if (lines.isEmpty()) continue
                val end = lines.last().optDouble("to", 0.0)
                val head = lines.take(8).joinToString(" ") { it.optString("content") }
                val zh = head.count { it.code in 0x4E00..0x9FFF }
                val kw = title.split(Regex("[:：，,、（）()【】\\[\\]\\s]+")).filter { it.length >= 2 }.take(6)
                var s = 0.0
                if (end >= duration * .85 && end <= duration * 1.15) s += 5.0
                if (kw.any { head.contains(it) }) s += 3.0
                if (zh > 5) s += 3.0
                s += minOf(lines.size, 450) / 450.0
                val text = lines.joinToString("\n") {
                    val t = it.optDouble("from", 0.0)
                    "[%02d:%02d] %s".format((t / 60).toInt(), (t % 60).toInt(), it.optString("content"))
                }
                cands += Cand(text, s)
            } catch (_: Exception) { /* 单个失败继续 */ }
        }
        return cands.maxByOrNull { it.score }?.text
    }

    /** 评论区文字版链接（无字幕 UP 的降级源）→ 正文文本；SPA 壳页解析 ORIGIN+markdown 数据源 */
    suspend fun textVersion(aid: Long, owner: String, title: String): String? {
        val links = mutableListOf<Pair<String, Int>>()
        try {
            val j = api("https://api.bilibili.com/x/v2/reply?type=1&oid=$aid&sort=1&ps=20")
            val d = j.optJSONObject("data") ?: return null
            val all = mutableListOf<JSONObject>()
            d.optJSONArray("top_replies")?.let { for (i in 0 until it.length()) all += it.getJSONObject(i) }
            d.optJSONArray("replies")?.let { for (i in 0 until minOf(it.length(), 20)) all += it.getJSONObject(i) }
            for (rep in all) {
                val msg = rep.optJSONObject("content")?.optString("message") ?: continue
                val isUp = rep.optJSONObject("member")?.optString("uname") == owner
                val hint = Regex("文字版|文字稿|逐字稿|文稿|全文").containsMatchIn(msg)
                for (m in Regex("https?://[^\\s\"'<>）)】\\]]+").findAll(msg)) {
                    val u = m.value.trimEnd('。', '，', '.', ',', '!', '？')
                    if (Regex("bilibili\\.com/(video|space|bangumi)").containsMatchIn(u)) continue
                    if (Regex("\\.(png|jpg|jpeg|gif|webp|mp4)(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(u)) continue
                    links += u to ((if (isUp) 2 else 0) + (if (hint) 3 else 0))
                }
            }
        } catch (_: Exception) { return null }
        val kw = title.split(Regex("[:：，,、（）()【】\\[\\]\\s]+")).filter { it.length >= 2 }.take(6)
        for ((u, _) in links.sortedByDescending { it.second }.distinctBy { it.first }.take(3)) {
            try {
                val raw = pageFetch(u).optString("text")
                val isHtml = raw.trimStart().startsWith("<")
                var text = if (isHtml) {
                    raw.replace(Regex("<script[\\s\\S]*?</script>|<style[\\s\\S]*?</style>"), " ")
                        .replace(Regex("<[^>]+>"), " ").replace(Regex("\\s+"), " ").trim()
                } else raw.trim()
                if (text.length < 300 && isHtml) {
                    val origin = Regex("ORIGIN\\s*=\\s*['\"]([^'\"]+)['\"]").find(raw)?.groupValues?.get(1)
                    val dates = Regex("\\d{4}-\\d{2}-\\d{2}").findAll(raw + title).map { it.value }.toSet().take(4)
                    if (origin != null) for (d in dates) {
                        val md = pageFetch("$origin/markdown/$d.md").optString("text")
                        if (md.length >= 300 && !md.trimStart().startsWith("<")) { text = md.trim(); break }
                    }
                }
                if (text.length >= 300 && kw.any { text.take(3000).contains(it) }) return text.take(240000)
            } catch (_: Exception) { /* 下一候选 */ }
        }
        return null
    }
}
