package com.bwm.videodigest

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
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

/** 薄荷曼波（Mint Mambo）配色：深绿 #3D9F3C 强调 · 深蓝 #367DB0 次强调 · 浅绿浅蓝填充 · 中灰描边 · 浅绿底 #F3FBF2 */
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var status: TextView
    private val cfg by lazy { getSharedPreferences("config", MODE_PRIVATE) }
    private val vault by lazy { getSharedPreferences("vault", MODE_PRIVATE) }

    // —— 薄荷曼波色板 ——
    private val deepGreen = Color.parseColor("#3D9F3C")   // 强调
    private val lightGreen = Color.parseColor("#9ED17B")  // 浅绿填充
    private val deepBlue = Color.parseColor("#367DB0")    // 次强调
    private val lightBlue = Color.parseColor("#9DC7DD")   // 浅蓝填充
    private val neutralGray = Color.parseColor("#D1D5DB") // 对照中灰（描边）
    private val inkGray = Color.parseColor("#374151")     // 正文深灰
    private val subGray = Color.parseColor("#6B7280")     // 辅助灰
    private val mintBg = Color.parseColor("#F3FBF2")      // 页面浅绿底
    private val gradientEnd = Color.parseColor("#519D78") // 渐变深端

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun rounded(fill: Int, stroke: Int? = null, radiusDp: Float = 12f) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = radiusDp * resources.displayMetrics.density
        setColor(fill)
        stroke?.let { setStroke(dp(1), it) }
    }

    /** 浅色输入框：白底 + 中灰描边，聚焦时深蓝描边（浅色块描边保护原则） */
    private fun fieldBg() = StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_focused), rounded(Color.WHITE, deepBlue, 10f))
        addState(intArrayOf(), rounded(Color.WHITE, neutralGray, 10f))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = gradientEnd
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(mintBg)
            setPadding(dp(16), dp(16), dp(16), dp(28))
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(mintBg)
            isFillViewport = true
            addView(root)
        })

        // —— 头图卡片：深绿→#519D78 渐变 ——
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(deepGreen, gradientEnd)).apply { cornerRadius = 16f * resources.displayMetrics.density }
            setPadding(dp(20), dp(18), dp(20), dp(18))
            addView(TextView(this@MainActivity).apply {
                text = "知了 Reelize"; textSize = 22f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.WHITE)
            })
            addView(TextView(this@MainActivity).apply {
                text = "视频更新自动总结速递"; textSize = 12f; setTextColor(Color.WHITE); alpha = 0.85f
            })
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, dp(16)) })

        fun card(): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(Color.WHITE, neutralGray, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(16))
        }

        fun section(parent: LinearLayout, title: String, accent: Int = deepGreen) {
            parent.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 0, 0, dp(10))
                addView(View(this@MainActivity).apply {
                    background = rounded(accent, null, 2f)
                }, LinearLayout.LayoutParams(dp(4), dp(16)))
                addView(TextView(this@MainActivity).apply {
                    text = "  $title"; textSize = 15f; setTypeface(typeface, Typeface.BOLD); setTextColor(inkGray)
                })
            })
        }

        fun field(parent: LinearLayout, key: String, label: String, secret: Boolean = false, hint: String = ""): EditText {
            parent.addView(TextView(this).apply {
                text = label; textSize = 12f; setTextColor(subGray); setPadding(0, dp(8), 0, dp(4))
            })
            val e = EditText(this).apply {
                setText(cfg.getString(key, ""))
                this.hint = hint
                setHintTextColor(subGray)
                setTextColor(inkGray)
                textSize = 14f
                background = fieldBg()
                setPadding(dp(12), dp(10), dp(12), dp(10))
                if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            parent.addView(e, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            return e
        }

        fun button(text: String, primary: Boolean, onClick: (View) -> Unit): Button = Button(this).apply {
            this.text = text
            textSize = 14f
            isAllCaps = false
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(if (primary) Color.WHITE else deepBlue)
            background = if (primary) rounded(deepGreen, null, 10f) else rounded(Color.WHITE, deepBlue, 10f)
            stateListAnimator = null
            setPadding(dp(16), dp(6), dp(16), dp(6))
            setOnClickListener(onClick)
        }

        fun row(vararg views: View): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach { v ->
                addView(v, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(4); marginEnd = dp(4) })
            }
        }

        // —— 基础配置卡片 ——
        val card1 = card()
        section(card1, "监控与模型")
        val uid = field(card1, "uid", "B 站作者 UID", hint = "空间 URL 里那串数字")
        val modelApi = field(card1, "modelApi", "模型 API 地址（OpenAI 兼容 base URL）", hint = "https://api.example.com/v1")
        val modelName = field(card1, "modelName", "模型 ID")
        val modelKey = field(card1, "modelKey", "模型 API Key", secret = true)
        root.addView(card1, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })

        // —— 邮件卡片 ——
        val card2 = card()
        section(card2, "邮件发送", deepBlue)
        val to = field(card2, "to", "收件邮箱")
        val from = field(card2, "from", "发件邮箱（SMTP 账号）")
        val smtpPass = field(card2, "smtpPass", "SMTP 授权码", secret = true)
        val smtpHost = field(card2, "smtpHost", "SMTP 服务器（留空按发件域名推断）", hint = "smtp.163.com")
        root.addView(card2, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })

        // —— 安全卡片 ——
        val card3 = card()
        section(card3, "加密保存", deepBlue)
        card3.addView(TextView(this).apply {
            text = "保管密码以 PBKDF2 + AES-GCM 加密 Key 存本机；重启后解锁即免重输。"
            textSize = 12f; setTextColor(subGray); setPadding(0, 0, 0, dp(10))
        })
        card3.addView(row(
            button("设置保管密码", true) { promptVaultSave(modelKey, smtpPass) },
            button("解锁恢复 Key", false) { promptVaultUnlock(modelKey, smtpPass) }
        ))
        root.addView(card3, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })

        // —— 操作区 ——
        val card4 = card()
        section(card4, "运行")
        card4.addView(android.widget.Switch(this).apply {
            text = "生成图文讲解页（lecture.html 随邮件发送）"
            textSize = 13f; setTextColor(inkGray)
            isChecked = cfg.getString("lecture", "false") == "true"
            setPadding(0, 0, 0, dp(6))
            setOnCheckedChangeListener { _, checked ->
                cfg.edit().putString("lecture", if (checked) "true" else "false").apply()
                Toast.makeText(this@MainActivity, if (checked) "已开启讲解页（已自动保存）" else "已关闭讲解页（已自动保存）", Toast.LENGTH_SHORT).show()
            }
        })
        card4.addView(button("保存配置", true) {
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
            val pass = vault.getString("pass", null)
            if (pass != null) {
                try {
                    Vault.save(this, pass, mapOf("modelKey" to modelKey.text.toString().trim(),
                        "smtpPass" to smtpPass.text.toString().trim()))
                    log("配置已保存，敏感项已加密存本机")
                } catch (e: Exception) { log("配置已保存（加密失败：${e.message}）") }
            } else log("配置已保存")
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)))
        card4.addView(button("打开 bilibili 登录（须登录后才能读取）", false) {
            val web = WebView(this).apply {
                settings.javaScriptEnabled = true; settings.domStorageEnabled = true
                webViewClient = WebViewClient()
                loadUrl("https://passport.bilibili.com/login")
            }
            android.app.AlertDialog.Builder(this).setView(web).setTitle("登录 bilibili（关闭对话框即完成）")
                .setPositiveButton("完成") { d, _ ->
                    val cookies = CookieManager.getInstance().getCookie("https://www.bilibili.com") ?: ""
                    log(if (cookies.contains("SESSDATA")) "登录态已保存" else "未检测到登录态，请重试")
                    d.dismiss()
                }.show()
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(8) })
        card4.addView(button("立即检查更新", true) {
            log("开始检查…")
            scope.launch {
                try { Pipeline(this@MainActivity) { runOnUiThread { log(it) } }.runOnce() }
                catch (e: Exception) { log("❌ ${e.message}") }
            }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply { topMargin = dp(8) })
        root.addView(card4, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })

        // —— 日志卡片（浅蓝底 + 深灰描边） ——
        val card5 = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(lightBlue, subGray, 14f)
            setPadding(dp(16), dp(14), dp(16), dp(16))
        }
        section(card5, "运行日志", deepBlue)
        status = TextView(this).apply {
            textSize = 12f; setTextColor(inkGray); gravity = Gravity.START
            background = rounded(Color.WHITE, neutralGray, 10f)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            minHeight = dp(120)
        }
        card5.addView(status)
        root.addView(card5)
    }

    private fun promptVaultSave(modelKey: EditText, smtpPass: EditText) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "至少 8 位"; background = fieldBg(); setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        android.app.AlertDialog.Builder(this).setTitle("设置保管密码").setView(input)
            .setPositiveButton("确定") { _, _ ->
                val p = input.text.toString()
                if (p.length < 8) { Toast.makeText(this, "至少 8 个字符", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                try {
                    Vault.save(this, p, mapOf("modelKey" to modelKey.text.toString().trim(),
                        "smtpPass" to smtpPass.text.toString().trim()))
                    vault.edit().putString("pass", p).apply()
                    log("已启用加密保存；重启后点「解锁恢复 Key」即可")
                } catch (e: Exception) { log("加密保存失败：${e.message}") }
            }.setNegativeButton("取消", null).show()
    }

    private fun promptVaultUnlock(modelKey: EditText, smtpPass: EditText) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            background = fieldBg(); setPadding(dp(12), dp(10), dp(12), dp(10))
        }
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
    }

    private fun log(msg: String) {
        status.text = "${status.text}\n• $msg".trim()
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
