package com.lightreader.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/** Host-only harness: compile alongside the unmodified AiClient at each pinned revision. */
public final class AiEvalRunner {
    public static void main(String[] args) throws Exception {
        if (args.length >= 1 && "describe".equals(args[0])) {
            Method method = AiClient.class.getDeclaredMethod("systemPrompt");
            method.setAccessible(true);
            JSONObject description = new JSONObject().put("system_prompt", method.invoke(null));
            if (args.length == 3) description.put("endpoint", AiClient.resolveEndpoint(args[1], args[2]).toString());
            System.out.println(description);
            return;
        }
        String key = System.getenv("LIGHTREADER_EVAL_API_KEY");
        if (key == null || key.isBlank()) throw new IllegalStateException("缺少 LIGHTREADER_EVAL_API_KEY");
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null) {
            JSONObject request = new JSONObject(line);
            JSONObject channel = request.getJSONObject("channel");
            channel.put("apiKey", key);
            long start = System.nanoTime();
            JSONObject record = new JSONObject();
            try {
                AiClient.Result result = AiClient.request(channel,
                        request.optJSONArray("history") == null ? new JSONArray() : request.getJSONArray("history"),
                        request.getString("prompt"), false);
                record.put("request_ms", (System.nanoTime() - start) / 1_000_000.0);
                boolean empty = result.text.isBlank() || "AI 没有返回结果。".equals(result.text)
                        || "AI 没有返回文字结果。".equals(result.text);
                record.put("status", empty ? "empty_output" : "ok");
                record.put("raw_text", result.text);
                record.put("citations", new JSONObject(result.citations));
            } catch (Exception error) {
                record.put("request_ms", (System.nanoTime() - start) / 1_000_000.0);
                record.put("status", "request_error");
                // AiClient reports status/path, not the server body. Never log a key or request headers.
                String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                record.put("error", message.replace(key, "[REDACTED]"));
                record.put("error_type", error.getClass().getSimpleName());
            }
            System.out.println(record);
            System.out.flush();
        }
    }
}
