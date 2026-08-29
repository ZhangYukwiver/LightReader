package com.lightreader.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

public final class MainActivity extends Activity {
    private static final int OPEN_TEXT = 1;
    private static final int CREATE_EXPORT = 2;
    private static final int MAX_TEXT_BYTES = 20 * 1024 * 1024;
    private static final int MAX_HTML_CHARS = 5 * 1024 * 1024;
    private static final String PREFS = "reader_state";
    private static final String RECENT_FILES_KEY = "recent_files";
    private static final String READING_PROGRESS_PREFIX = "reading_progress:";
    // Edited content is a private draft; the read-only source URI is never overwritten.
    private static final String EDITED_DOCUMENT_DIR = "edited_documents";
    private static final int MAX_EDITED_STATE_BYTES = 16 * 1024 * 1024;
    private static final int MAX_RECENT_FILES = 20;

    private WebView webView;
    private boolean pageReady;
    private volatile String currentUri;
    private volatile String currentTitle;
    private volatile String currentText;
    private volatile String currentTextHash;
    private volatile String currentSourceHash;
    private volatile String currentHtml;
    private volatile boolean currentDocx;
    private volatile boolean currentEdited;
    private volatile byte[] currentSourceBytes;
    private volatile String currentDocumentToken;
    private volatile byte[] pendingExport;
    private SecretStore secretStore;
    private volatile boolean destroyed;
    private volatile String pendingExportFormat;
    private final AtomicInteger openGeneration = new AtomicInteger();
    private int htmlTopInsetPx;
    private int htmlBottomInsetPx;
    private int htmlImeInsetPx;
    private OnBackInvokedCallback backCallback;

    private static final class EditedDocument {
        final String text;
        final String html;

        EditedDocument(String text, String html) {
            this.text = text;
            this.html = html;
        }
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled") // JavaScript only renders the bundled local reader asset.
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        secretStore = new SecretStore(this);
        webView = new ReaderWebView(this);
        if (Build.VERSION.SDK_INT >= 30) htmlTopInsetPx = statusBarFallbackPx();
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        // DOCX pinch gestures are scoped to the document by reader.html; native WebView
        // page zoom would also scale the toolbar and make reset ambiguous.
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        webView.addJavascriptInterface(new ReaderBridge(), "ReaderBridge");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                applyHtmlInsets();
                showCurrentDocument();
                sendRecentFiles();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith("file:///android_asset/");
            }
        });
        webView.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets status = windowInsets.getInsetsIgnoringVisibility(
                        WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout());
                Insets navigation = windowInsets.getInsetsIgnoringVisibility(
                        WindowInsets.Type.navigationBars());
                Insets ime = windowInsets.getInsets(WindowInsets.Type.ime());
                htmlTopInsetPx = Math.max(status.top, statusBarFallbackPx());
                htmlBottomInsetPx = navigation.bottom;
                htmlImeInsetPx = ime.bottom;
            } else {
                // Pre-Android 11 decor windows already fit their content below system bars.
                htmlTopInsetPx = 0;
                htmlBottomInsetPx = 0;
                htmlImeInsetPx = 0;
            }
            // Let the bundled page own the inset. WebView padding is inconsistent across
            // Android System WebView versions when edge-to-edge is enforced.
            view.setPadding(0, 0, 0, 0);
            applyHtmlInsets();
            if (Build.VERSION.SDK_INT >= 30) return WindowInsets.CONSUMED;
            return windowInsets;
        });
        applySystemTheme(false);
        setContentView(webView);
        webView.requestApplyInsets();
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        webView.loadUrl("file:///android_asset/reader.html");
        if (savedInstanceState != null) {
            String uri = savedInstanceState.getString("currentUri");
            if (uri != null) {
                int generation = openGeneration.incrementAndGet();
                new Thread(() -> openText(Uri.parse(uri), generation), "restore-text").start();
            }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (currentUri != null) outState.putString("currentUri", currentUri);
    }

    @Override
    protected void onPause() {
        if (pageReady && webView != null && !destroyed) {
            webView.evaluateJavascript("window.flushReadingProgress && window.flushReadingProgress()", null);
        }
        super.onPause();
    }

    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (pageReady && webView != null && !destroyed) {
            webView.evaluateJavascript(
                    "window.handleNativeBack ? window.handleNativeBack() : false",
                    handled -> {
                        if ("true".equals(handled)) return;
                        if (destroyed) return;
                        if (currentText != null && webView != null) {
                            webView.evaluateJavascript("window.goHome && window.goHome()", null);
                        } else {
                            finish();
                        }
                    });
            return;
        }
        if (currentText != null) clearDocumentState();
        else finish();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (requestCode == OPEN_TEXT) {
            if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) {
                try {
                    getContentResolver().takePersistableUriPermission(
                            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException ignored) {
                    // Some document providers grant access only for the current session.
                }
            }
            int generation = openGeneration.incrementAndGet();
            new Thread(() -> openText(uri, generation), "open-text").start();
        } else if (requestCode == CREATE_EXPORT && pendingExport != null) {
            byte[] bytes = pendingExport;
            String format = pendingExportFormat;
            pendingExport = null;
            pendingExportFormat = null;
            new Thread(() -> writeExport(uri, bytes, format), "write-export").start();
        }
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        openGeneration.incrementAndGet();
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
            backCallback = null;
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        super.onActionModeStarted(mode);
        // Fallback for WebView implementations that bypass the subclass hook.
        if (mode != null) {
            Menu menu = mode.getMenu();
            if (menu != null) menu.clear();
            mode.finish();
        }
    }

    private void openText(Uri uri, int generation) {
        try {
            String title = displayName(uri);
            boolean docx = isDocx(uri, title);
            if (!docx && !isText(uri, title)) {
                throw new IOException("第一版支持 TXT 和 DOCX 文件");
            }
            byte[] sourceBytes = readLimited(uri);
            String html = null;
            String text;
            if (docx) {
                DocxRenderer.Content content = readDocx(sourceBytes);
                text = content.text;
                html = content.html;
                if (html.length() > MAX_HTML_CHARS) html = null;
            } else {
                text = decode(sourceBytes);
            }
            text = text.replace("\r\n", "\n").replace('\r', '\n');
            // Only reuse a draft for the exact source package that produced it.
            String sourceHash = docx ? sha256(sourceBytes) : null;
            EditedDocument edited = docx ? loadEditedDocument(uri.toString(), sourceHash) : null;
            if (edited != null) {
                text = edited.text;
                html = edited.html;
            }
            String textHash = sha256(text);
            if (destroyed || generation != openGeneration.get()) return;
            currentUri = uri.toString();
            currentTitle = title == null || title.trim().isEmpty() ? "未命名.txt" : title;
            currentText = text;
            currentTextHash = textHash;
            currentSourceHash = sourceHash;
            currentHtml = html;
            currentDocx = docx;
            currentEdited = edited != null;
            currentSourceBytes = sourceBytes;
            currentDocumentToken = UUID.randomUUID().toString();
            try {
                rememberRecentFile(currentUri, currentTitle, currentDocx, savedNoteCount(currentUri));
            } catch (Exception ignored) {
                // Recent-file metadata is optional; it must not block reading the file.
            }
            runOnUiThread(this::showCurrentDocument);
            sendRecentFiles();
        } catch (Exception error) {
            if (!destroyed && generation == openGeneration.get()) {
                toast(error.getMessage() == null ? "无法打开文件" : error.getMessage());
            }
        }
    }

    private boolean isDocx(Uri uri, String title) {
        String mime = getContentResolver().getType(uri);
        return (title != null && title.toLowerCase(java.util.Locale.ROOT).endsWith(".docx"))
                || "application/vnd.openxmlformats-officedocument.wordprocessingml.document".equals(mime);
    }

    private boolean isText(Uri uri, String title) {
        String mime = getContentResolver().getType(uri);
        return (mime != null && mime.startsWith("text/"))
                || (title != null && title.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(txt|text|log|md|csv)$"));
    }

    private DocxRenderer.Content readDocx(byte[] sourceBytes) throws Exception {
        return DocxRenderer.render(sourceBytes);
    }

    private byte[] readLimited(Uri uri) throws IOException {
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("无法读取文件");
            return readLimited(input, MAX_TEXT_BYTES, "第一版最多打开 20 MB 的文本文件");
        }
    }

    private byte[] readLimited(InputStream input, int maxBytes, String tooLargeMessage)
            throws IOException {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 64 * 1024))) {
            byte[] buffer = new byte[64 * 1024];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > maxBytes) throw new IOException(tooLargeMessage);
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private String decode(byte[] bytes) throws CharacterCodingException {
        if (bytes.length >= 3 && bytes[0] == (byte) 0xEF && bytes[1] == (byte) 0xBB
                && bytes[2] == (byte) 0xBF) {
            return new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8);
        }
        if (bytes.length >= 2 && bytes[0] == (byte) 0xFF && bytes[1] == (byte) 0xFE) {
            return new String(bytes, 2, bytes.length - 2, StandardCharsets.UTF_16LE);
        }
        if (bytes.length >= 2 && bytes[0] == (byte) 0xFE && bytes[1] == (byte) 0xFF) {
            return new String(bytes, 2, bytes.length - 2, StandardCharsets.UTF_16BE);
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException ignored) {
            return Charset.forName("GB18030").newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPLACE)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {
            // Fall back to the URI segment below.
        }
        return uri.getLastPathSegment();
    }

    private void showCurrentDocument() {
        String title = currentTitle;
        String text = currentText;
        String token = currentDocumentToken;
        boolean docx = currentDocx;
        boolean edited = currentEdited;
        String html = currentHtml;
        if (destroyed || webView == null || !pageReady || text == null || token == null) return;
        String notes = loadNotes();
        String progress = loadReadingProgress();
        String script;
        if (docx) {
            script = "window.loadDocument(" + JSONObject.quote(title) + ","
                    + JSONObject.quote(text) + "," + notes + ","
                    + JSONObject.quote("DOCX") + ","
                    + (html == null ? "null" : JSONObject.quote(html)) + ","
                    + JSONObject.quote(progress) + ","
                    + (edited ? "true" : "false") + ")";
        } else {
            // Keep large TXT payloads out of evaluateJavascript. The page pulls bounded
            // chunks through ReaderBridge while yielding between batches.
            script = "window.beginTextDocument(" + JSONObject.quote(title) + ","
                    + notes + "," + JSONObject.quote(progress) + ","
                    + JSONObject.quote(token) + "," + text.length() + ")";
        }
        webView.evaluateJavascript(script, null);
    }

    private void clearDocumentState() {
        openGeneration.incrementAndGet();
        currentUri = null;
        currentTitle = null;
        currentText = null;
        currentTextHash = null;
        currentSourceHash = null;
        currentHtml = null;
        currentDocx = false;
        currentEdited = false;
        currentSourceBytes = null;
        currentDocumentToken = null;
        pendingExport = null;
        pendingExportFormat = null;
    }

    private JSONArray storedRecentFiles() {
        try {
            String raw = getSharedPreferences(PREFS, MODE_PRIVATE)
                    .getString(RECENT_FILES_KEY, "[]");
            return raw == null ? new JSONArray() : new JSONArray(raw);
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private Uri parseRecentUri(String value) {
        if (value == null || value.length() > 4096) {
            throw new IllegalArgumentException("最近文件地址无效");
        }
        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        if (!"content".equalsIgnoreCase(scheme) && !"file".equalsIgnoreCase(scheme)) {
            throw new IllegalArgumentException("最近文件地址无效");
        }
        return uri;
    }

    private JSONArray sortedRecentFiles(JSONArray source) {
        List<JSONObject> items = new ArrayList<>();
        for (int i = 0; i < source.length(); i++) {
            JSONObject item = source.optJSONObject(i);
            if (item != null && !item.optString("uri", "").isEmpty()) items.add(item);
        }
        items.sort((left, right) -> {
            int pinned = Boolean.compare(right.optBoolean("pinned", false),
                    left.optBoolean("pinned", false));
            if (pinned != 0) return pinned;
            return Long.compare(right.optLong("lastOpened", 0), left.optLong("lastOpened", 0));
        });
        JSONArray result = new JSONArray();
        for (JSONObject item : items) {
            if (result.length() >= MAX_RECENT_FILES) break;
            result.put(item);
        }
        return result;
    }

    private synchronized void rememberRecentFile(String uri, String title, boolean docx,
                                                  int notes) throws Exception {
        if (uri == null || uri.isEmpty()) return;
        int noteCount = Math.max(0, notes);
        String name = title == null || title.trim().isEmpty() ? "未命名文件" : trim(title, 200);
        JSONArray stored = storedRecentFiles();
        boolean pinned = false;
        for (int i = 0; i < stored.length(); i++) {
            JSONObject item = stored.optJSONObject(i);
            if (item != null && uri.equals(item.optString("uri", ""))) {
                pinned = item.optBoolean("pinned", false);
                break;
            }
        }
        JSONArray updated = new JSONArray();
        updated.put(new JSONObject()
                .put("uri", uri)
                .put("name", name)
                .put("format", docx ? "DOCX" : "TXT")
                .put("noteCount", noteCount)
                .put("modified", currentEdited || noteCount > 0)
                .put("pinned", pinned)
                .put("lastOpened", System.currentTimeMillis()));
        for (int i = 0; i < stored.length(); i++) {
            JSONObject item = stored.optJSONObject(i);
            if (item == null || uri.equals(item.optString("uri", ""))) continue;
            updated.put(item);
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(RECENT_FILES_KEY, sortedRecentFiles(updated).toString()).commit();
    }

    private synchronized boolean setRecentFilePinned(String uri, boolean pinned) throws Exception {
        JSONArray stored = storedRecentFiles();
        boolean found = false;
        for (int i = 0; i < stored.length(); i++) {
            JSONObject item = stored.optJSONObject(i);
            if (item != null && uri.equals(item.optString("uri", ""))) {
                item.put("pinned", pinned);
                found = true;
                break;
            }
        }
        if (found) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(RECENT_FILES_KEY, sortedRecentFiles(stored).toString()).apply();
        }
        return found;
    }

    private synchronized boolean deleteRecentFile(String uri) throws Exception {
        JSONArray stored = storedRecentFiles();
        JSONArray updated = new JSONArray();
        boolean removed = false;
        for (int i = 0; i < stored.length(); i++) {
            JSONObject item = stored.optJSONObject(i);
            if (item == null || uri.equals(item.optString("uri", ""))) {
                if (item != null && uri.equals(item.optString("uri", ""))) removed = true;
                continue;
            }
            updated.put(item);
        }
        if (removed) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(RECENT_FILES_KEY, sortedRecentFiles(updated).toString()).apply();
        }
        return removed;
    }

    private synchronized JSONArray publicRecentFiles() throws Exception {
        JSONArray result = new JSONArray();
        JSONArray stored = sortedRecentFiles(storedRecentFiles());
        for (int i = 0; i < stored.length(); i++) {
            JSONObject item = stored.optJSONObject(i);
            if (item == null) continue;
            String uri = item.optString("uri", "");
            if (uri.isEmpty()) continue;
            int notes = Math.max(0, item.optInt("noteCount", 0));
            notes = Math.max(notes, savedNoteCount(uri));
            result.put(new JSONObject()
                    .put("uri", uri)
                    .put("name", item.optString("name", "未命名文件"))
                    .put("format", "DOCX".equals(item.optString("format")) ? "DOCX" : "TXT")
                    .put("noteCount", notes)
                    .put("modified", item.optBoolean("modified", false) || notes > 0)
                    .put("pinned", item.optBoolean("pinned", false))
                    .put("lastOpened", item.optLong("lastOpened", 0)));
        }
        return result;
    }

    private int savedNoteCount(String uri) {
        if (uri == null || uri.isEmpty()) return 0;
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString("notes:" + uri, null);
        if (saved == null) return 0;
        try {
            JSONObject state = new JSONObject(saved);
            if (uri.equals(currentUri) && currentTextHash != null
                    && !currentTextHash.equals(state.optString("textHash"))) return 0;
            int stored = state.optInt("noteCount", -1);
            if (stored >= 0) return stored;
            return Math.max(0, state.getJSONArray("notes").length());
        } catch (Exception ignored) {
            return 0;
        }
    }

    private void sendRecentFiles() {
        runOnUiThread(() -> {
            try {
                String state = publicRecentFiles().toString();
                if (!destroyed && pageReady && webView != null) {
                    webView.evaluateJavascript("window.onRecentFiles(" + JSONObject.quote(state) + ")", null);
                }
            } catch (Exception ignored) {
                // A malformed old preference should not block opening documents.
            }
        });
    }

    private int statusBarFallbackPx() {
        int resource = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resource != 0) return getResources().getDimensionPixelSize(resource);
        return Math.round(24 * getResources().getDisplayMetrics().density);
    }

    private void applyHtmlInsets() {
        if (!pageReady || webView == null || destroyed) return;
        float density = getResources().getDisplayMetrics().density;
        String top = formatCssPx(htmlTopInsetPx / density);
        String bottom = formatCssPx(htmlBottomInsetPx / density);
        String ime = formatCssPx(htmlImeInsetPx / density);
        webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--native-top-inset','" + top
                        + "px');document.documentElement.style.setProperty('--native-bottom-inset','"
                        + bottom + "px');document.documentElement.style.setProperty('--native-ime-inset','"
                        + ime + "px');", null);
    }

    private String formatCssPx(float value) {
        return String.format(java.util.Locale.ROOT, "%.2f", value);
    }

    private String loadNotes() {
        if (currentUri == null || currentText == null) return "[]";
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString("notes:" + currentUri, null);
        if (saved == null) return "[]";
        try {
            JSONObject state = new JSONObject(saved);
            String hash = currentTextHash == null ? sha256(currentText) : currentTextHash;
            if (!hash.equals(state.optString("textHash"))) return "[]";
            return state.getJSONArray("notes").toString();
        } catch (Exception ignored) {
            return "[]";
        }
    }

    private String loadReadingProgress() {
        if (currentUri == null) return "0";
        String raw = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(READING_PROGRESS_PREFIX + currentUri, "0");
        try {
            double value = Double.parseDouble(raw);
            if (Double.isNaN(value) || Double.isInfinite(value)) return "0";
            return formatProgress(Math.max(0, Math.min(1, value)));
        } catch (Exception ignored) {
            return "0";
        }
    }

    private void saveReadingProgress(String raw) {
        if (currentUri == null || raw == null || raw.length() > 32) return;
        try {
            double value = Double.parseDouble(raw);
            if (Double.isNaN(value) || Double.isInfinite(value)) return;
            value = Math.max(0, Math.min(1, value));
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(READING_PROGRESS_PREFIX + currentUri, formatProgress(value)).apply();
        } catch (Exception ignored) {
            // Ignore malformed progress from the page; it must not affect reading.
        }
    }

    private String formatProgress(double value) {
        return String.format(java.util.Locale.ROOT, "%.6f", value);
    }

    private File editedDocumentFile(String uri) throws Exception {
        return new File(getDir(EDITED_DOCUMENT_DIR, MODE_PRIVATE), sha256(uri) + ".json");
    }

    private synchronized void saveEditedDocumentState(String uri, String sourceHash,
                                                       String text, String html) throws Exception {
        if (sourceHash == null || sourceHash.isEmpty()) {
            throw new IllegalArgumentException("原文标识无效");
        }
        byte[] bytes = new JSONObject()
                .put("format", "DOCX")
                .put("sourceHash", sourceHash)
                .put("text", text)
                .put("html", html)
                .toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_EDITED_STATE_BYTES) {
            throw new IllegalArgumentException("修改内容过大，无法保存");
        }
        File target = editedDocumentFile(uri);
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
        }
        if (!temporary.renameTo(target)) {
            temporary.delete();
            throw new IOException("无法保存修改");
        }
    }

    private EditedDocument loadEditedDocument(String uri, String sourceHash) {
        try {
            File file = editedDocumentFile(uri);
            if (!file.isFile() || file.length() > MAX_EDITED_STATE_BYTES) return null;
            String raw;
            try (FileInputStream input = new FileInputStream(file)) {
                raw = new String(readLimited(input, MAX_EDITED_STATE_BYTES, "编辑内容过大"),
                        StandardCharsets.UTF_8);
            }
            JSONObject state = new JSONObject(raw);
            if (!"DOCX".equals(state.optString("format"))
                    || !sourceHash.equals(state.optString("sourceHash"))) return null;
            String text = state.optString("text", null);
            String html = state.optString("html", null);
            if (text == null || html == null || text.length() > MAX_TEXT_BYTES
                    || html.length() > MAX_HTML_CHARS) return null;
            return new EditedDocument(text, html);
        } catch (Exception ignored) {
            return null;
        }
    }

    private void saveNotes(String json) throws Exception {
        if (currentUri == null || currentText == null || json == null || json.length() > 2_000_000) {
            throw new IllegalArgumentException("批注数据无效");
        }
        String raw = json.trim();
        JSONObject payload = raw.startsWith("{") ? new JSONObject(raw) : null;
        JSONArray notes = payload == null ? new JSONArray(raw) : payload.optJSONArray("notes");
        if (notes == null) throw new IllegalArgumentException("批注数据无效");
        int annotationCount = payload == null
                ? notes.length() : payload.optInt("noteCount", notes.length());
        if (annotationCount < 0 || annotationCount > MAX_TEXT_BYTES) {
            throw new IllegalArgumentException("批注数量无效");
        }
        String hash = currentTextHash == null ? sha256(currentText) : currentTextHash;
        JSONObject state = new JSONObject()
                .put("textHash", hash)
                .put("notes", notes)
                // A global note is one editable record; noteCount is its expanded place count.
                .put("noteCount", annotationCount);
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("notes:" + currentUri, state.toString()).commit()) {
            throw new IOException("无法保存批注");
        }
        try {
            rememberRecentFile(currentUri, currentTitle, currentDocx, annotationCount);
        } catch (Exception ignored) {
            // The annotation itself is already persisted even if the list update fails.
        }
        sendRecentFiles();
    }

    private void prepareExport(String blocksJson) {
        if (currentText == null) {
            toast("请先打开文件");
            return;
        }
        try {
            boolean editedDocx = currentDocx && blocksJson != null && !blocksJson.isEmpty();
            if (editedDocx && blocksJson.length() > 16_000_000) {
                throw new IllegalArgumentException("修改内容过大，无法导出");
            }
            if (editedDocx && currentSourceBytes != null) {
                pendingExport = DocxStyledExporter.write(currentSourceBytes, blocksJson);
            } else if (editedDocx) {
                // Source package unavailable: fall back to a plain rebuilt DOCX.
                ByteArrayOutputStream output = new ByteArrayOutputStream(currentText.length() + 4096);
                DocxExporter.write(output, currentText, List.of());
                pendingExport = output.toByteArray();
            } else if (currentSourceBytes != null) {
                pendingExport = currentSourceBytes.clone();
            } else {
                pendingExport = currentText.getBytes(StandardCharsets.UTF_8);
            }
            pendingExportFormat = currentDocx ? "DOCX" : "TXT";
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(currentDocx
                            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            : "text/plain")
                    .putExtra(Intent.EXTRA_TITLE, exportName());
            runOnUiThread(() -> startActivityForResult(intent, CREATE_EXPORT));
        } catch (Exception error) {
            toast(error.getMessage() == null ? "导出失败" : error.getMessage());
        }
    }

    private String exportName() {
        String title = currentTitle == null || currentTitle.trim().isEmpty() ? "文档" : currentTitle;
        return title.lastIndexOf('.') > 0 ? title : title + (currentDocx ? ".docx" : ".txt");
    }

    private void saveEditedDocument(String json) throws Exception {
        if (currentUri == null || currentText == null || !currentDocx) {
            throw new IllegalArgumentException("当前没有可编辑的 Word 文档");
        }
        if (json == null || json.length() > 16_000_000) {
            throw new IllegalArgumentException("修改内容过大，无法保存");
        }
        JSONObject payload = new JSONObject(json);
        String text = payload.getString("text").replace("\r\n", "\n").replace('\r', '\n');
        String html = payload.getString("html");
        JSONArray notes = payload.getJSONArray("notes");
        if (html.length() > MAX_HTML_CHARS) {
            throw new IllegalArgumentException("文档过大，无法保存");
        }
        String sourceHash = currentSourceHash;
        if (sourceHash == null) {
            sourceHash = currentSourceBytes == null ? sha256(currentText) : sha256(currentSourceBytes);
        }
        saveEditedDocumentState(currentUri, sourceHash, text, html);
        currentText = text;
        currentTextHash = sha256(text);
        currentHtml = html;
        currentSourceHash = sourceHash;
        currentEdited = true;
        saveNotes(new JSONObject()
                .put("notes", notes)
                .put("noteCount", payload.optInt("noteCount", notes.length()))
                .toString());
    }

    private void writeExport(Uri uri, byte[] bytes, String format) {
        try (OutputStream output = getContentResolver().openOutputStream(uri, "w")) {
            if (output == null) throw new IOException("无法创建导出文件");
            output.write(bytes);
            toast("已导出 " + (format == null ? "文件" : format));
        } catch (Exception error) {
            toast(error.getMessage() == null ? "导出失败" : error.getMessage());
        }
    }

    private String rawAiState() throws Exception {
        String raw = secretStore.read();
        return raw == null || raw.trim().isEmpty()
                ? new JSONObject().put("selectedId", "").put("channels", new JSONArray()).toString()
                : raw;
    }

    private JSONObject publicAiState() throws Exception {
        JSONObject raw = new JSONObject(rawAiState());
        JSONArray channels = raw.optJSONArray("channels");
        JSONArray publicChannels = new JSONArray();
        if (channels != null) {
            for (int i = 0; i < channels.length(); i++) {
                JSONObject channel = channels.optJSONObject(i);
                if (channel == null) continue;
                publicChannels.put(new JSONObject()
                        .put("id", channel.optString("id"))
                        .put("name", channel.optString("name"))
                        .put("protocol", channel.optString("protocol", "chat"))
                        .put("baseUrl", channel.optString("baseUrl"))
                        .put("model", channel.optString("model"))
                        .put("webSearch", channel.optBoolean("webSearch", false))
                        .put("hasKey", !channel.optString("apiKey", "").isEmpty()));
            }
        }
        return new JSONObject()
                .put("selectedId", raw.optString("selectedId", ""))
                .put("channels", publicChannels);
    }

    private void saveAiState(String candidateJson) throws Exception {
        if (candidateJson == null || candidateJson.length() > 300_000) {
            throw new IllegalArgumentException("AI 渠道配置过大");
        }
        JSONObject candidate = new JSONObject(candidateJson);
        JSONObject old = new JSONObject(rawAiState());
        JSONArray oldChannels = old.optJSONArray("channels");
        JSONArray channels = candidate.optJSONArray("channels");
        if (channels == null || channels.length() > 20) throw new IllegalArgumentException("最多保存 20 个 AI 渠道");
        JSONArray normalized = new JSONArray();
        for (int i = 0; i < channels.length(); i++) {
            JSONObject input = channels.optJSONObject(i);
            if (input == null) continue;
            String id = input.optString("id", "").trim();
            if (id.isEmpty()) id = UUID.randomUUID().toString();
            String protocol = "responses".equals(input.optString("protocol")) ? "responses" : "chat";
            String baseUrl = trim(input.optString("baseUrl", ""), 500).trim();
            if (baseUrl.isEmpty() || !baseUrl.startsWith("https://")) {
                throw new IllegalArgumentException("AI 渠道地址必须是 HTTPS");
            }
            String apiKey = input.optString("apiKey", "").trim();
            if (apiKey.isEmpty()) apiKey = oldApiKey(oldChannels, id);
            normalized.put(new JSONObject()
                    .put("id", id)
                    .put("name", trim(input.optString("name", "未命名渠道"), 64))
                    .put("protocol", protocol)
                    .put("baseUrl", baseUrl)
                    .put("model", trim(input.optString("model", ""), 128))
                    .put("webSearch", protocol.equals("responses") && input.optBoolean("webSearch", false))
                    .put("apiKey", apiKey));
        }
        String selected = candidate.optString("selectedId", "");
        if (!containsChannel(normalized, selected) && normalized.length() > 0) {
            selected = normalized.getJSONObject(0).getString("id");
        }
        secretStore.write(new JSONObject().put("selectedId", selected).put("channels", normalized).toString());
    }

    private String oldApiKey(JSONArray channels, String id) {
        if (channels == null) return "";
        for (int i = 0; i < channels.length(); i++) {
            JSONObject channel = channels.optJSONObject(i);
            if (channel != null && id.equals(channel.optString("id"))) return channel.optString("apiKey", "");
        }
        return "";
    }

    private boolean containsChannel(JSONArray channels, String id) {
        for (int i = 0; i < channels.length(); i++) {
            JSONObject channel = channels.optJSONObject(i);
            if (channel != null && id.equals(channel.optString("id"))) return true;
        }
        return false;
    }

    private JSONObject findAiChannel(String id) throws Exception {
        JSONArray channels = new JSONObject(rawAiState()).optJSONArray("channels");
        if (channels == null) return null;
        for (int i = 0; i < channels.length(); i++) {
            JSONObject channel = channels.optJSONObject(i);
            if (channel != null && id.equals(channel.optString("id"))) return channel;
        }
        return null;
    }

    private void sendAiRequest(String requestJson) {
        final JSONObject request;
        try {
            request = new JSONObject(requestJson);
        } catch (Exception error) {
            toast("AI 请求格式无效");
            return;
        }
        new Thread(() -> {
            String requestId = request.optString("id", "");
            try {
                JSONObject channel = findAiChannel(request.optString("channelId", ""));
                if (channel == null) throw new IllegalArgumentException("请先选择 AI 渠道");
                AiClient.Result result = AiClient.request(
                        channel,
                        request.optJSONArray("history") == null ? new JSONArray() : request.optJSONArray("history"),
                        request.optString("prompt", ""),
                        request.optBoolean("webSearch", false));
                JSONObject payload = new JSONObject()
                        .put("id", requestId)
                        .put("ok", true)
                        .put("text", result.text);
                JSONArray citations = new JSONArray();
                for (java.util.Map.Entry<String, String> citation : result.citations.entrySet()) {
                    citations.put(new JSONObject().put("url", citation.getKey()).put("title", citation.getValue()));
                }
                payload.put("citations", citations);
                deliverAiResult(payload);
            } catch (Exception error) {
                try {
                    deliverAiResult(new JSONObject().put("id", requestId).put("ok", false)
                            .put("error", error.getMessage() == null ? "AI 请求失败" : error.getMessage()));
                } catch (Exception ignored) {
                    // JSONObject construction cannot fail for these primitive fields.
                }
            }
        }, "ai-request").start();
    }

    private void deliverAiResult(JSONObject payload) {
        if (destroyed) return;
        runOnUiThread(() -> {
            if (webView != null && !destroyed) {
                webView.evaluateJavascript("window.onAiResult(" + JSONObject.quote(payload.toString()) + ")", null);
            }
        });
    }

    private String trim(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    private String sha256(String value) throws Exception {
        return sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private String sha256(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) hex.append(String.format("%02x", b & 0xff));
        return hex.toString();
    }

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    @SuppressWarnings("deprecation")
    private void applySystemTheme(boolean dark) {
        int background = Color.parseColor(dark ? "#171916" : "#f7f5ef");
        int navigation = Color.parseColor(dark ? "#20231f" : "#fffef9");
        webView.setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(navigation);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else {
            int flags = dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (!dark) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    public final class ReaderBridge {
        @JavascriptInterface
        public void openTextFile() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*")
                        .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                                "text/plain",
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"})
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(intent, OPEN_TEXT);
            });
        }

        @JavascriptInterface
        public void openRecentFile(String value) {
            try {
                Uri uri = parseRecentUri(value);
                int generation = openGeneration.incrementAndGet();
                new Thread(() -> openText(uri, generation), "open-recent").start();
            } catch (Exception error) {
                toast(error.getMessage() == null ? "最近文件地址无效" : error.getMessage());
            }
        }

        @JavascriptInterface
        public String getTextChunk(String token, int start, int length) {
            String text = currentText;
            if (text == null || token == null || !token.equals(currentDocumentToken)
                    || start < 0 || length <= 0 || start >= text.length()) return "";
            int end = (int) Math.min((long) text.length(), (long) start + Math.min(length, 96 * 1024));
            // Keep UTF-16 surrogate pairs intact at chunk boundaries so JS offsets stay
            // identical to the source String used for annotations and export.
            if (end < text.length() && end > start && Character.isHighSurrogate(text.charAt(end - 1))) {
                end--;
            }
            if (end == start) end = Math.min(text.length(), start + 1);
            return text.substring(start, end);
        }

        @JavascriptInterface
        public void getRecentFiles() {
            sendRecentFiles();
        }

        @JavascriptInterface
        public void setRecentFilePinned(String value, boolean pinned) {
            try {
                parseRecentUri(value);
                if (!MainActivity.this.setRecentFilePinned(value, pinned)) {
                    toast("项目不存在");
                    return;
                }
                sendRecentFiles();
            } catch (Exception error) {
                toast(error.getMessage() == null ? "项目置顶失败" : error.getMessage());
            }
        }

        @JavascriptInterface
        public void deleteRecentFile(String value) {
            try {
                parseRecentUri(value);
                if (!MainActivity.this.deleteRecentFile(value)) {
                    toast("项目不存在");
                    return;
                }
                sendRecentFiles();
            } catch (Exception error) {
                toast(error.getMessage() == null ? "项目删除失败" : error.getMessage());
            }
        }

        @JavascriptInterface
        public void saveAnnotations(String json) {
            try {
                saveNotes(json);
            } catch (Exception error) {
                toast("批注保存失败");
            }
        }

        @JavascriptInterface
        public void saveReadingProgress(String value) {
            MainActivity.this.saveReadingProgress(value);
        }

        @JavascriptInterface
        public void copyText(String text) {
            if (text == null || text.isEmpty()) return;
            String selectedText = text;
            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(ClipData.newPlainText("轻阅选文", selectedText));
                    toast("已复制选中文字");
                }
            });
        }

        @JavascriptInterface
        public void exportDocument(String blocksJson) {
            prepareExport(blocksJson);
        }

        @JavascriptInterface
        public void saveEditedDocument(String json) {
            try {
                MainActivity.this.saveEditedDocument(json);
            } catch (Exception error) {
                toast(error.getMessage() == null ? "保存修改失败" : error.getMessage());
            }
        }

        @JavascriptInterface
        public void clearDocumentState() {
            MainActivity.this.clearDocumentState();
        }

        @JavascriptInterface
        public void getAiState() {
            new Thread(() -> {
                try {
                    String state = publicAiState().toString();
                    runOnUiThread(() -> {
                        if (!destroyed && webView != null) {
                            webView.evaluateJavascript("window.onAiState(" + JSONObject.quote(state) + ")", null);
                        }
                    });
                } catch (Exception error) {
                    toast("无法读取 AI 渠道设置");
                }
            }, "read-ai-state").start();
        }

        @JavascriptInterface
        public void saveAiState(String json) {
            try {
                MainActivity.this.saveAiState(json);
                toast("AI 渠道已保存");
            } catch (Exception error) {
                toast(error.getMessage() == null ? "AI 渠道保存失败" : error.getMessage());
            }
        }

        @JavascriptInterface
        public void sendAiRequest(String json) {
            MainActivity.this.sendAiRequest(json);
        }

        @JavascriptInterface
        public void openExternalUrl(String url) {
            try {
                URL external = new URL(url);
                if (!"https".equalsIgnoreCase(external.getProtocol())) return;
                runOnUiThread(() -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                        toast("无法打开来源链接");
                    }
                });
            } catch (Exception ignored) {
                toast("来源链接无效");
            }
        }

        @JavascriptInterface
        public void showMessage(String message) {
            toast(message);
        }

        @JavascriptInterface
        public void setDarkMode(boolean dark) {
            runOnUiThread(() -> applySystemTheme(dark));
        }
    }

    /** Keeps text selection handles while letting the HTML toolbar own selection actions. */
    private static final class ReaderWebView extends WebView {
        ReaderWebView(Context context) {
            super(context);
        }

        @Override
        public ActionMode startActionMode(ActionMode.Callback callback) {
            return new NoOpActionMode();
        }

        @Override
        public ActionMode startActionMode(ActionMode.Callback callback, int type) {
            return new NoOpActionMode();
        }

        @Override
        public ActionMode startActionModeForChild(View originalView, ActionMode.Callback callback) {
            return new NoOpActionMode();
        }

        @Override
        public ActionMode startActionModeForChild(View originalView, ActionMode.Callback callback, int type) {
            return new NoOpActionMode();
        }
    }

    private static final class NoOpActionMode extends ActionMode {
        @Override public void setTitle(CharSequence title) {}
        @Override public void setTitle(int resId) {}
        @Override public void setSubtitle(CharSequence subtitle) {}
        @Override public void setSubtitle(int resId) {}
        @Override public void setCustomView(View view) {}
        @Override public void invalidate() {}
        @Override public void finish() {}
        @Override public Menu getMenu() { return null; }
        @Override public CharSequence getTitle() { return null; }
        @Override public CharSequence getSubtitle() { return null; }
        @Override public View getCustomView() { return null; }
        @Override public MenuInflater getMenuInflater() { return null; }
    }
}
