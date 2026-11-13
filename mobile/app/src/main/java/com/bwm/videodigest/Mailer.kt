package com.bwm.videodigest

import android.util.Base64
import java.io.BufferedReader
import java.io.BufferedWriter
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** 直连 SMTP（465 SSL / 587 STARTTLS），移植自 relay-worker.js 的 smtpSend。 */
object Mailer {
    private fun trustAll(): SSLSocket {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(a: Array<out X509Certificate>?, b: String?) {}
            override fun checkServerTrusted(a: Array<out X509Certificate>?, b: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }), SecureRandom())
        return ctx.socketFactory.createSocket() as SSLSocket
    }

    private class Conn(val socket: Socket, val r: BufferedReader, val w: BufferedWriter) {
        fun read(): String {
            val sb = StringBuilder()
            while (true) {
                val line = r.readLine() ?: throw Exception("连接中断")
                sb.append(line).append("\n")
                if (line.length < 4 || line[3] != '-') return sb.toString().trim()
            }
        }
        fun cmd(s: String) { w.write(s + "\r\n"); w.flush() }
    }

    /** 返回 null 表示成功；否则返回错误说明（deliveryUnknown=true 表示投递结果未知）。 */
    fun send(host: String, port: Int, user: String, pass: String, from: String, to: String,
             subject: String, html: String, attachments: List<Pair<String, ByteArray>> = emptyList()): Pair<String?, Boolean> {
        var conn: Conn? = null
        try {
            val plain: Socket = if (port == 465) trustAll().apply {
                connect(java.net.InetSocketAddress(host, port), 20000)
                startHandshake()
            } else Socket(host, port)
            conn = Conn(if (port == 465) plain else plain,
                plain.getInputStream().bufferedReader(Charsets.ISO_8859_1),
                plain.getOutputStream().bufferedWriter(Charsets.ISO_8859_1))
            var c = conn
            if (port != 465) {
                c.read(); c.cmd("EHLO bwm-mobile")
                val ehlo = c.read()
                if (!ehlo.contains("STARTTLS")) return "服务器不支持 STARTTLS" to false
                c.cmd("STARTTLS"); c.read()
                val ssl = trustAll()
                ssl.connect(java.net.InetSocketAddress(host, port), 20000)
                ssl.startHandshake()
                c = Conn(ssl, ssl.getInputStream().bufferedReader(Charsets.ISO_8859_1), ssl.getOutputStream().bufferedWriter(Charsets.ISO_8859_1))
                conn = c
            } else { c.read() }
            c.cmd("EHLO bwm-mobile"); c.read()
            c.cmd("AUTH LOGIN"); c.read()
            c.cmd(Base64.encodeToString(user.toByteArray(), Base64.NO_WRAP)); c.read()
            c.cmd(Base64.encodeToString(pass.toByteArray(), Base64.NO_WRAP))
            if (!c.read().startsWith("235")) return "SMTP 认证失败，请核对授权码" to false
            c.cmd("MAIL FROM:<$from>"); c.read()
            c.cmd("RCPT TO:<$to>"); c.read()
            c.cmd("DATA"); c.read()
            val boundary = "=bwm_" + System.currentTimeMillis().toString(36)
            val head = buildString {
                appendLine("From: <$from>"); appendLine("To: <$to>")
                appendLine("Subject: =?UTF-8?B?${Base64.encodeToString(subject.toByteArray(), Base64.NO_WRAP)}?=")
                appendLine("MIME-Version: 1.0")
                appendLine("Content-Type: multipart/mixed; boundary=\"$boundary\"")
            }
            val body = StringBuilder(head).appendLine()
            body.appendLine("--$boundary").appendLine("Content-Type: text/html; charset=UTF-8").appendLine("Content-Transfer-Encoding: base64").appendLine()
            body.appendLine(Base64.encodeToString(html.toByteArray(), Base64.NO_WRAP)).appendLine()
            for ((name, bytes) in attachments) {
                body.appendLine("--$boundary").appendLine("Content-Type: application/octet-stream; name=\"$name\"")
                body.appendLine("Content-Disposition: attachment; filename=\"$name\"").appendLine("Content-Transfer-Encoding: base64").appendLine()
                body.appendLine(Base64.encodeToString(bytes, Base64.NO_WRAP)).appendLine()
            }
            body.appendLine("--$boundary--")
            for (line in body.toString().split("\r?\n".toRegex())) {
                c.cmd(if (line.startsWith(".")) ".$line" else line)
            }
            c.cmd(".")
            if (!c.read().startsWith("250")) return "SMTP 投递失败（未返回 250）" to true
            c.cmd("QUIT")
            return null to false
        } catch (e: Exception) {
            return ("发信异常：" + e.message) to (conn != null)
        } finally { try { conn?.socket?.close() } catch (_: Exception) {} }
    }
}
