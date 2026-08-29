package com.lightreader.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Minimal network client for configurable Responses and OpenAI-compatible channels. */
public final class AiClient {
    private static final int MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

    private AiClient() {}

    public static final class Result {
        public final String text;
        public final Map<String, String> citations;

        Result(String text, Map<String, String> citations) {
            this.text = text;
            this.citations = citations;
        }
    }

    public static Result request(JSONObject channel, JSONArray history, String prompt,
                                 boolean webSearch) throws Exception {
        String protocol = channel.optString("protocol", "chat");
        String key = channel.optString("apiKey", "").trim();
        String model = channel.optString("model", "").trim();
        String endpoint = channel.optString("baseUrl", "").trim();
        if (key.isEmpty()) throw new IllegalArgumentException("请先配置当前渠道的 API Key");
        if (model.isEmpty()) throw new IllegalArgumentException("请先配置当前渠道的模型名称");
        if (endpoint.isEmpty()) throw new IllegalArgumentException("请先配置当前渠道的 API 地址");
        URL url = resolveEndpoint(endpoint, protocol);
        if ("responses".equals(protocol)) {
            return requestResponses(url, key, model, history, prompt, webSearch);
        }
        if (webSearch) throw new IllegalArgumentException("当前渠道协议不支持内置联网搜索");
        return requestChat(url, key, model, history, prompt);
    }

    /**
     * Accept a provider base URL as well as a complete endpoint. The UI keeps
     * the user's value unchanged; resolution happens at the single network
     * boundary so every AI action follows the same rule.
     */
    static URL resolveEndpoint(String raw, String protocol) throws Exception {
        URL base = new URL(raw);
        if (!"https".equalsIgnoreCase(base.getProtocol())) {
            throw new IllegalArgumentException("API 地址必须使用 HTTPS");
        }

        String path = base.getPath() == null ? "" : base.getPath();
        while (path.length() > 1 && path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        String suffix = "responses".equals(protocol) ? "/responses" : "/chat/completions";

        if (path.isEmpty() || "/".equals(path)) {
            // DeepSeek documents its base URL without /v1; most other
            // OpenAI-compatible providers use the conventional /v1 prefix.
            path = "api.deepseek.com".equalsIgnoreCase(base.getHost())
                    ? suffix : "/v1" + suffix;
        } else if ("/v1".equals(path)) {
            path += suffix;
        } else {
            // An explicit custom route (including a complete endpoint) is
            // authoritative; do not guess or rewrite its path.
            return base;
        }

        return new URI(base.getProtocol(), base.getUserInfo(), base.getHost(), base.getPort(),
                path, base.getQuery(), base.getRef()).toURL();
    }

    private static Result requestResponses(URL url, String key, String model, JSONArray history,
                                           String prompt, boolean webSearch) throws Exception {
        JSONObject body = new JSONObject()
                .put("model", model)
                .put("input", transcript(history, prompt));
        if (webSearch) {
            body.put("tools", new JSONArray().put(new JSONObject().put("type", "web_search")))
                    .put("tool_choice", "required")
                    .put("include", new JSONArray().put("web_search_call.action.sources"));
        }
        JSONObject response = post(url, key, body);
        return parseResponses(response);
    }

    private static Result requestChat(URL url, String key, String model, JSONArray history,
                                      String prompt) throws Exception {
        JSONArray messages = new JSONArray()
                .put(new JSONObject().put("role", "system").put("content", systemPrompt()));
        for (int i = 0; i < history.length() && i < 8; i++) {
            JSONObject item = history.optJSONObject(i);
            if (item == null) continue;
            String role = "assistant".equals(item.optString("role")) ? "assistant" : "user";
            String text = trim(item.optString("text", ""), 6000);
            if (!text.isEmpty()) messages.put(new JSONObject().put("role", role).put("content", text));
        }
        messages.put(new JSONObject().put("role", "user").put("content", trim(prompt, 12000)));
        JSONObject body = new JSONObject().put("model", model).put("messages", messages);
        JSONObject response = post(url, key, body);
        return parseChat(response);
    }

    private static String systemPrompt() {
        return "你是轻阅中的阅读助手。用用户提问的语言回答，先给结论，再给必要解释。"
                + "不要编造来源；如果启用了联网搜索，只使用返回的搜索结果并保留引用。";
    }

    private static String transcript(JSONArray history, String prompt) {
        StringBuilder text = new StringBuilder(systemPrompt()).append("\n\n");
        for (int i = 0; i < history.length() && i < 8; i++) {
            JSONObject item = history.optJSONObject(i);
            if (item == null) continue;
            String role = "assistant".equals(item.optString("role")) ? "AI" : "用户";
            text.append(role).append("：").append(trim(item.optString("text", ""), 6000)).append('\n');
        }
        return text.append("\n用户当前问题：").append(trim(prompt, 12000)).toString();
    }

    private static JSONObject post(URL url, String key, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + key);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            byte[] request = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(request);
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String response = read(stream);
            if (status < 200 || status >= 300) {
                if (status == HttpURLConnection.HTTP_NOT_FOUND) {
                    throw new IllegalStateException("AI 请求失败（HTTP 404）：接口不存在（已请求 "
                            + url.getPath() + "），请检查协议、基础地址和模型名称");
                }
                throw new IllegalStateException("AI 请求失败（HTTP " + status + "）");
            }
            return new JSONObject(response);
        } finally {
            connection.disconnect();
        }
    }

    private static Result parseResponses(JSONObject response) {
        String outputText = response.optString("output_text", "").trim();
        Map<String, String> citations = new LinkedHashMap<>();
        JSONArray output = response.optJSONArray("output");
        if (output != null) {
            for (int i = 0; i < output.length(); i++) {
                JSONObject item = output.optJSONObject(i);
                if (item == null) continue;
                if ("message".equals(item.optString("type"))) {
                    JSONArray content = item.optJSONArray("content");
                    if (content == null) continue;
                    for (int j = 0; j < content.length(); j++) {
                        JSONObject part = content.optJSONObject(j);
                        if (part == null) continue;
                        if (outputText.isEmpty() && "output_text".equals(part.optString("type"))) {
                            outputText = part.optString("text", "").trim();
                        }
                        collectAnnotations(part.optJSONArray("annotations"), citations);
                    }
                }
                JSONObject action = item.optJSONObject("action");
                collectSources(action == null ? null : action.optJSONArray("sources"), citations);
            }
        }
        if (outputText.isEmpty()) outputText = "AI 没有返回文字结果。";
        return new Result(outputText, citations);
    }

    private static Result parseChat(JSONObject response) {
        Map<String, String> citations = new LinkedHashMap<>();
        JSONArray choices = response.optJSONArray("choices");
        if (choices == null || choices.length() == 0) return new Result("AI 没有返回结果。", citations);
        JSONObject choice = choices.optJSONObject(0);
        JSONObject message = choice == null ? null : choice.optJSONObject("message");
        if (message == null) return new Result("AI 没有返回结果。", citations);
        String text = message.optString("content", "");
        if (text.isEmpty()) {
            JSONArray parts = message.optJSONArray("content");
            if (parts != null) {
                StringBuilder joined = new StringBuilder();
                for (int i = 0; i < parts.length(); i++) {
                    JSONObject part = parts.optJSONObject(i);
                    if (part != null) joined.append(part.optString("text", ""));
                }
                text = joined.toString();
            }
        }
        collectAnnotations(message.optJSONArray("annotations"), citations);
        return new Result(text.trim().isEmpty() ? "AI 没有返回文字结果。" : text.trim(), citations);
    }

    private static void collectAnnotations(JSONArray annotations, Map<String, String> citations) {
        if (annotations == null) return;
        for (int i = 0; i < annotations.length(); i++) {
            JSONObject annotation = annotations.optJSONObject(i);
            JSONObject citation = annotation == null ? null : annotation.optJSONObject("url_citation");
            if (citation != null) addCitation(citation.optString("url", ""), citation.optString("title", ""), citations);
        }
    }

    private static void collectSources(JSONArray sources, Map<String, String> citations) {
        if (sources == null) return;
        for (int i = 0; i < sources.length(); i++) {
            JSONObject source = sources.optJSONObject(i);
            if (source != null) addCitation(source.optString("url", ""), source.optString("title", ""), citations);
        }
    }

    private static void addCitation(String url, String title, Map<String, String> citations) {
        if (url.startsWith("https://") && !citations.containsKey(url)) {
            citations.put(url, title.isEmpty() ? url : title);
        }
    }

    private static String read(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("AI 响应过大");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String trim(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max) + "…";
    }
}
