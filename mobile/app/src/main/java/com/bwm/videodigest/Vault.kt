package com.bwm.videodigest

import android.content.Context
import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** PBKDF2-SHA256 + AES-256-GCM 保管密码金库（与桌面版设计一致）。 */
object Vault {
    private const val ITERATIONS = 300000
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("vault", Context.MODE_PRIVATE)

    private fun derive(pass: String, salt: ByteArray): SecretKeySpec {
        val spec = PBEKeySpec(pass.toCharArray(), salt, ITERATIONS, 256)
        val bits = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        return SecretKeySpec(bits, "AES")
    }

    private fun seal(key: SecretKeySpec, plain: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        return Base64.encodeToString(iv + c.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }

    private fun open(key: SecretKeySpec, blob: String): String {
        val raw = Base64.decode(blob, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, raw, 0, 12))
        return String(c.doFinal(raw, 12, raw.size - 12))
    }

    @Throws(Exception::class)
    fun save(ctx: Context, pass: String, entries: Map<String, String>) {
        require(pass.length >= 8) { "保管密码至少 8 个字符" }
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val key = derive(pass, salt)
        val e = prefs(ctx).edit().clear()
        e.putString("salt", Base64.encodeToString(salt, Base64.NO_WRAP))
        entries.forEach { (id, v) -> e.putString(id, seal(key, v)) }
        e.apply()
    }

    @Throws(Exception::class)
    fun load(ctx: Context, pass: String): Map<String, String> {
        val p = prefs(ctx)
        val saltB = p.getString("salt", null) ?: return emptyMap()
        val key = derive(pass, Base64.decode(saltB, Base64.NO_WRAP))
        return p.all.filterKeys { it != "salt" }.mapValues { open(key, it.value as String) }
    }

    fun exists(ctx: Context) = prefs(ctx).contains("salt")
    fun clear(ctx: Context) { prefs(ctx).edit().clear().apply() }
}
