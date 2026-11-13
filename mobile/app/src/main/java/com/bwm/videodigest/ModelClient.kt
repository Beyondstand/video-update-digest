package com.bwm.videodigest

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** OpenAI 兼容 /chat/completions（与桌面 modelJson 同构）。 */
object ModelClient {
    suspend fun chat(apiBase: String, key: String, model: String, system: String, user: String): JSONObject =
        withContext(Dispatchers.IO) {
            val conn = URL("${apiBase.trimEnd('/')}/chat/completions").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 20000
            conn.readTimeout = 180000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $key")
            val body = JSONObject()
                .put("model", model)
                .put("temperature", 0.3)
                .put("messages", org.json.JSONArray()
                    .put(JSONObject().put("role", "system").put("content", system))
                    .put(JSONObject().put("role", "user").put("content", user)))
                .toString()
            conn.outputStream.use { it.write(body.toByteArray()) }
            if (conn.responseCode != 200) throw Exception("模型 API 返回 HTTP ${conn.responseCode}")
            val text = conn.inputStream.bufferedReader().readText()
            val content = JSONObject(text).getJSONArray("choices").getJSONObject(0)
                .getJSONObject("message").getString("content")
            val cleaned = content.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
            JSONObject(cleaned)
        }
}

/** 模型输出校验（对齐桌面 validateModel 的硬边界）。 */
object Output {
    fun validate(o: JSONObject, shotCount: Int): JSONObject {
        for (k in listOf("reportHtml", "summary", "review")) {
            val v = o.optString(k)
            if (v.isBlank() || v.length > (if (k == "reportHtml") 80000 else 12000)) throw Exception("模型输出 $k 缺失或过长")
        }
        val caps = o.optJSONArray("captions") ?: throw Exception("模型输出 captions 缺失")
        if (caps.length() != shotCount) throw Exception("模型图注数量不正确")
        return o
    }
}
