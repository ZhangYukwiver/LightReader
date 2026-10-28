package com.lightreader.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/** Per-document conversations. Results belong to the originating document, even after navigation. */
final class AiConversationStore {
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private final File directory;
    private final Set<String> active = new HashSet<>();

    AiConversationStore(File directory) { this.directory = directory; }

    synchronized JSONObject load(String uri) throws Exception {
        JSONObject data = read(uri);
        boolean changed = false;
        for (String key : new String[]{"messages", "pageMessages"}) {
            JSONArray messages = data.getJSONArray(key);
            for (int i = 0; i < messages.length(); i++) {
                JSONObject message = messages.getJSONObject(i);
                if (message.optBoolean("pending") && !active.contains(uri + "\n" + message.optString("id"))) {
                    message.put("pending", false).put("error", true)
                            .put("text", "上次请求已中断，请重新发送问题。");
                    changed = true;
                }
            }
        }
        if (changed) write(uri, data);
        return data;
    }

    synchronized void save(String uri, JSONObject incoming) throws Exception {
        JSONObject data = read(uri);
        for (String key : new String[]{"messages", "pageMessages"}) {
            JSONArray source = incoming.getJSONArray(key);
            JSONArray target = data.getJSONArray(key);
            for (int i = 0; i < source.length(); i++) {
                JSONObject message = source.getJSONObject(i);
                String id = message.getString("id");
                if (id.isEmpty() || id.length() > 200 || !("user".equals(message.optString("role"))
                        || "assistant".equals(message.optString("role")))) throw new IOException("对话数据无效");
                int at = find(target, id);
                if (at < 0) target.put(message);
                else if (!(message.optBoolean("pending") && !target.getJSONObject(at).optBoolean("pending"))) {
                    target.put(at, message);
                }
            }
        }
        data.put("anchor", incoming.opt("anchor"));
        data.put("contextId", incoming.optString("contextId"));
        write(uri, data);
    }

    synchronized void begin(String uri, String id) throws Exception {
        JSONObject data = read(uri);
        JSONObject message = findMessage(data, id);
        if (message == null || !message.optBoolean("pending")) throw new IOException("请先保存当前问题再发送");
        active.add(uri + "\n" + id);
    }

    synchronized void finish(String uri, String id, JSONObject result) throws Exception {
        try {
            JSONObject data = read(uri);
            JSONObject message = findMessage(data, id);
            if (message == null) throw new IOException("未找到请求对应的会话");
            boolean ok = result.optBoolean("ok");
            message.put("pending", false).put("error", !ok)
                    .put("text", ok ? result.optString("text") : "请求失败：" + result.optString("error"))
                    .put("citations", result.optJSONArray("citations") == null ? new JSONArray() : result.getJSONArray("citations"));
            write(uri, data);
        } finally {
            active.remove(uri + "\n" + id);
        }
    }

    private JSONObject findMessage(JSONObject data, String id) throws Exception {
        for (String key : new String[]{"messages", "pageMessages"}) {
            JSONArray messages = data.getJSONArray(key);
            int at = find(messages, id);
            if (at >= 0) return messages.getJSONObject(at);
        }
        return null;
    }

    private int find(JSONArray messages, String id) throws Exception {
        for (int i = 0; i < messages.length(); i++) {
            if (id.equals(messages.getJSONObject(i).optString("id"))) return i;
        }
        return -1;
    }

    private JSONObject read(String uri) throws Exception {
        File file = file(uri);
        if (!file.exists()) return new JSONObject().put("version", 1)
                .put("messages", new JSONArray()).put("pageMessages", new JSONArray());
        if (file.length() > MAX_BYTES) throw new IOException("已保存的会话过大，原记录未改动");
        JSONObject data = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        if (data.optInt("version") != 1 || data.optJSONArray("messages") == null
                || data.optJSONArray("pageMessages") == null) throw new IOException("会话文件无法读取，原记录未改动");
        return data;
    }

    private void write(String uri, JSONObject data) throws Exception {
        byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("会话超过 8 MB，未覆盖已保存的记录");
        File target = file(uri);
        File temporary = new File(directory, target.getName() + ".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(temporary)) {
                out.write(bytes);
                out.getFD().sync();
            }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temporary.toPath());
        }
    }

    private File file(String uri) throws Exception {
        if (uri == null || uri.isEmpty()) throw new IOException("没有可保存会话的文档");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建会话目录");
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(uri.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : hash) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return new File(directory, name + ".json");
    }
}
