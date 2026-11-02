package com.lightreader.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

public final class BookKnowledgeStoreCheck {
    public static void main(String[] args) throws Exception {
        Path folder = Files.createTempDirectory("reader-knowledge-check-");
        try {
            BookKnowledgeStore store = new BookKnowledgeStore(folder.toFile());
            JSONObject data = new JSONObject().put("version", 1).put("method", "bm25").put("source", "hash-a")
                    .put("chunks", new JSONArray().put(new JSONObject().put("id", "K000001").put("start", 0).put("end", 100)))
                    .put("postings", new JSONObject().put("知识", new JSONArray().put(0).put(2)));
            store.save("book-a", "hash-a", data.toString());
            if (store.load("book-b") != null) throw new AssertionError("Books share an index");
            JSONObject reopened = new BookKnowledgeStore(folder.toFile()).load("book-a");
            if (reopened.getJSONObject("postings").getJSONArray("知识").getInt(1) != 2) throw new AssertionError("Index lost after restart");
            try { store.save("book-a", "changed-hash", data.toString()); throw new AssertionError("Stale source was accepted"); }
            catch (java.io.IOException expected) { }
            if (!"hash-a".equals(store.load("book-a").getString("source"))) throw new AssertionError("Failed save overwrote original index");
            data.put("source", "hash-new"); store.save("book-a", "hash-new", data.toString());
            if (!"hash-new".equals(store.load("book-a").getString("source"))) throw new AssertionError("Rebuild did not replace index");
            System.out.println("BookKnowledgeStoreCheck OK: restart, document isolation, stale-source rejection, replacement");
        } finally {
            try (var paths = Files.walk(folder)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }
}
