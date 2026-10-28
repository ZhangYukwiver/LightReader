package com.lightreader.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

/** Host-side check of conversation persistence, document isolation and late results. */
public final class AiConversationStoreCheck {
    public static void main(String[] args) throws Exception {
        Path folder = Files.createTempDirectory("reader-conversations-check-");
        try {
            AiConversationStore store = new AiConversationStore(folder.toFile());
            JSONObject pending = conversation("request-a");
            store.save("document-a", pending);
            store.begin("document-a", "request-a");
            check(store.load("document-a").getJSONArray("messages").getJSONObject(0).getBoolean("pending"),
                    "An active request should remain pending after reopening its document");
            store.save("document-b", conversation("request-b"));
            store.finish("document-a", "request-a", new JSONObject().put("ok", true).put("text", "A 的回答"));
            store.save("document-a", pending);
            JSONObject restored = new AiConversationStore(folder.toFile()).load("document-a");
            JSONObject answer = restored.getJSONArray("messages").getJSONObject(0);
            check("A 的回答".equals(answer.getString("text")), "A stale pending snapshot replaced the saved answer");
            check(!answer.getBoolean("pending"), "A completed response remained pending");
            JSONObject interrupted = new AiConversationStore(folder.toFile()).load("document-b")
                    .getJSONArray("messages").getJSONObject(0);
            check(interrupted.getBoolean("error") && !interrupted.getBoolean("pending"),
                    "A request interrupted by a restart should allow retry");
            check(store.load("document-c").getJSONArray("messages").length() == 0, "Documents share messages");
            check(restored.getJSONArray("pageMessages").getJSONObject(0).getString("text").equals("独立对话"),
                    "Page conversation did not survive restart");
            check(restored.getJSONObject("anchor").getString("quote").equals("原引用"), "Quote was lost");
            try (var files = Files.list(folder)) {
                Path record = files.filter(path -> path.toString().endsWith(".json")).findFirst().orElseThrow();
                Files.writeString(record, "invalid json");
                for (String uri : new String[]{"document-a", "document-b"}) {
                    try { store.save(uri, conversation("replacement")); }
                    catch (Exception expected) { /* A corrupt record must never be silently overwritten. */ }
                }
                check(Files.readString(record).equals("invalid json"), "A corrupt record was overwritten");
            }
            System.out.println("AiConversationStoreCheck OK: restart, isolation, late replies and corrupt-file preservation");
        } finally {
            try (var paths = Files.walk(folder)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static JSONObject conversation(String id) throws Exception {
        return new JSONObject().put("messages", new JSONArray().put(new JSONObject()
                .put("id", id).put("role", "assistant").put("pending", true).put("text", "请求中")))
                .put("pageMessages", new JSONArray().put(new JSONObject().put("id", "page-" + id)
                        .put("role", "user").put("text", "独立对话")))
                .put("anchor", new JSONObject().put("quote", "原引用")).put("contextId", "context-" + id);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
