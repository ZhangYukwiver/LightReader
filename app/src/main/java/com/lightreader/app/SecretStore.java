package com.lightreader.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Small Android Keystore wrapper for API keys and channel profiles. */
public final class SecretStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "lightreader.channels.v1";
    private static final String PREFS = "encrypted_ai_state";
    private static final String VALUE = "value";
    private static final int IV_BYTES = 12;

    private final SharedPreferences preferences;

    public SecretStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public synchronized void write(String plainText) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        // Android Keystore rejects caller-provided IVs when randomized encryption is required.
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_BYTES) throw new IllegalStateException("加密 IV 无效");
        byte[] encrypted = cipher.doFinal(plainText.getBytes(StandardCharsets.UTF_8));
        byte[] payload = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, payload, 0, iv.length);
        System.arraycopy(encrypted, 0, payload, iv.length, encrypted.length);
        if (!preferences.edit().putString(VALUE, Base64.encodeToString(payload, Base64.NO_WRAP)).commit()) {
            throw new IllegalStateException("无法保存 AI 渠道");
        }
    }

    public synchronized String read() throws Exception {
        String encoded = preferences.getString(VALUE, null);
        if (encoded == null || encoded.isEmpty()) return null;
        byte[] payload = Base64.decode(encoded, Base64.DEFAULT);
        if (payload.length <= IV_BYTES) throw new IllegalStateException("AI 渠道数据损坏");
        byte[] iv = Arrays.copyOfRange(payload, 0, IV_BYTES);
        byte[] encrypted = Arrays.copyOfRange(payload, IV_BYTES, payload.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    public synchronized void clear() {
        preferences.edit().remove(VALUE).apply();
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance("AES", KEYSTORE);
            generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    android.security.keystore.KeyProperties.PURPOSE_ENCRYPT
                            | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
    }
}
