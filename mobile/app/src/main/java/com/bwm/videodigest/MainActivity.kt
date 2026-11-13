package com.bwm.videodigest

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var status: TextView
    private val cfg by lazy { getSharedPreferences("config", MODE_PRIVATE) }
    private val vault by lazy { getSharedPreferences("vault", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)

        fun field(key: String, label: String, secret: Boolean = false, hint: String = ""): EditText {
            root.addView(label(label))
            val e = EditText(this).apply {
                setText(cfg.getString(key, "")); this.hint = hint
                if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            root.addView(e)
            return e
        }
        val uid = field("uid", "B 站作者 UID", hint = "空间 URL 里那串数字")
        val modelApi = field("modelApi", "模型 API 地址（OpenAI 兼容 base URL）", hint = "https://api.example.com/v1")
        val modelName = field("modelName", "模型 ID")
        val modelKey = field("modelKey", "模型 API Key", secret = true)
        val to = field("to", "收件邮箱")
        val from = field("from", "发件邮箱（SMTP 账号）")
        val smtpPass = field("smtpPass", "SMTP 授权码", secret = true)
        val smtpHost = field("smtpHost", "SMTP 服务器（留空按发件域名推断）", hint = "smtp.163.com")

        root.addView(btn("保存配置") {
            cfg.edit()
                .putString("uid", uid.text.toString().trim())
                .putString("modelApi", modelApi.text.toString().trim())
                .putString("modelName", modelName.text.toString().trim())
                .putString("modelKey", modelKey.text.toString().trim())
                .putString("to", to.text.toString().trim())
                .putString("from", from.text.toString().trim())
                .putString("smtpPass", smtpPass.text.toString().trim())
                .putString("smtpHost", smtpHost.text.toString().trim())
                .putString("smtpPort", "465")
                .apply()
            // 同步加密保存 Key（与桌面金库同设计）
            val pass = vault.getString("pass", null)
            if (pass != null) {
                try {
                    Vault.save(this, pass, mapOf("modelKey" to modelKey.text.toString().trim(),
                        "smtpPass" to smtpPass.text.toString().trim()))
                    log("配置已保存，敏感项已加密存本机")
                } catch (e: Exception) { log("配置已保存（加密失败：${e.message}）") }
            } else log("配置已保存")
        })

        root.addView(btn("设置保管密码（加密存本机）") {
            val input = EditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; hint = "至少 8 位" }
            android.app.AlertDialog.Builder(this).setTitle("保管密码").setView(input)
                .setPositiveButton("确定") { _, _ ->
                    val p = input.text.toString()
                    if (p.length < 8) { Toast.makeText(this, "至少 8 个字符", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                    try {
                        Vault.save(this, p, mapOf("modelKey" to modelKey.text.toString().trim(),
                            "smtpPass" to smtpPass.text.toString().trim()))
                        vault.edit().putString("pass", p).apply()
                        log("已启用加密保存；重启后点「解锁」输入保管密码即可恢复 Key")
                    } catch (e: Exception) { log("加密保存失败：${e.message}") }
                }.setNegativeButton("取消", null).show()
        })

        root.addView(btn("解锁（重启后恢复 Key）") {
            val input = EditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
            android.app.AlertDialog.Builder(this).setTitle("输入保管密码").setView(input)
                .setPositiveButton("解锁") { _, _ ->
                    val p = input.text.toString()
                    scope.launch {
                        try {
                            val entries = Vault.load(this@MainActivity, p)
                            if (entries.isEmpty()) { log("没有已保存的加密 Key"); return@launch }
                            vault.edit().putString("pass", p).apply()
                            modelKey.setText(entries["modelKey"] ?: "")
                            smtpPass.setText(entries["smtpPass"] ?: "")
                            log("已解锁，${entries.size} 个 Key 已恢复")
                        } catch (e: Exception) { log("解锁失败：密码错误或数据损坏") }
                    }
                }.setNegativeButton("取消", null).show()
        })

        root.addView(btn("打开 bilibili 登录（须登录后才能读取）") {
            val web = WebView(this).apply { settings.javaScriptEnabled = true; settings.domStorageEnabled = true
                webViewClient = WebViewClient()
                loadUrl("https://passport.bilibili.com/login") }
            android.app.AlertDialog.Builder(this).setView(web).setTitle("登录 bilibili（关闭对话框即完成）")
                .setPositiveButton("完成") { d, _ ->
                    val cookies = CookieManager.getInstance().getCookie("https://www.bilibili.com") ?: ""
                    log(if (cookies.contains("SESSDATA")) "登录态已保存" else "未检测到登录态，请重试")
                    d.dismiss()
                }.show()
        })

        root.addView(btn("立即检查更新") {
            log("开始检查…")
            scope.launch {
                try { Pipeline(this@MainActivity) { runOnUiThread { log(it) } }.runOnce() }
                catch (e: Exception) { log("❌ ${e.message}") }
            }
        })

        root.addView(label("运行日志"))
        status = TextView(this).apply { textSize = 12f; gravity = Gravity.START }
        root.addView(status)
    }

    private fun label(t: String) = TextView(this).apply { text = t; setPadding(0, 24, 0, 8); textSize = 13f }
    private fun btn(t: String, onClick: (View) -> Unit) =
        Button(this).apply { text = t; setOnClickListener(onClick) }

    private fun log(msg: String) {
        status.text = "${status.text}\n[$msg]".trim()
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
