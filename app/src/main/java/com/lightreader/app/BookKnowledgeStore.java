package com.lightreader.app;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;

/** Derived per-document RAG indexes, kept outside conversation snapshots. */
final class BookKnowledgeStore {
    private static final int MAX_BYTES = 64 * 1024 * 1024;
    private final File directory;

    BookKnowledgeStore(File directory) { this.directory = directory; }

    synchronized JSONObject load(String uri) throws Exception {
        File file = file(uri);
        if (!file.exists()) return null;
        if (file.length() > MAX_BYTES) throw new IOException("知识库索引过大，请重建");
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    synchronized void save(String uri, String source, String raw) throws Exception {
        if (raw == null || raw.length() > MAX_BYTES) throw new IOException("知识库索引超过 64 MB");
        JSONObject data = new JSONObject(raw);
        if (data.optInt("version") != 1 || !"bm25".equals(data.optString("method"))
                || source == null || !source.equals(data.optString("source"))
                || data.optJSONArray("chunks") == null || data.optJSONObject("postings") == null) {
            throw new IOException("知识库数据无效或正文版本已变化");
        }
        byte[] bytes = raw.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("知识库索引超过 64 MB");
        File target = file(uri), temporary = new File(directory, target.getName() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes); output.getFD().sync();
            }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }

    private File file(String uri) throws Exception {
        if (uri == null || uri.isEmpty()) throw new IOException("没有可保存知识库的文档");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建知识库目录");
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(uri.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : hash) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return new File(directory, name + ".json");
    }
}
