package com.lightreader.app;

import java.net.URL;

/** Host-side smoke check for configurable AI endpoint resolution. */
public final class AiClientEndpointCheck {
    public static void main(String[] args) throws Exception {
        assertUrl("https://api.deepseek.com", "responses", "https://api.deepseek.com/responses");
        assertUrl("https://api.deepseek.com/", "chat", "https://api.deepseek.com/chat/completions");
        assertUrl("https://example.com", "responses", "https://example.com/v1/responses");
        assertUrl("https://example.com/v1/", "chat", "https://example.com/v1/chat/completions");
        assertUrl("https://example.com/v1/responses", "responses", "https://example.com/v1/responses");
        assertUrl("https://api.deepseek.com?tenant=test", "responses",
                "https://api.deepseek.com/responses?tenant=test");
        assertUrl("https://example.com/custom", "responses", "https://example.com/custom");
        try {
            AiClient.resolveEndpoint("http://example.com", "responses");
            throw new AssertionError("HTTP 地址未被拒绝");
        } catch (IllegalArgumentException expected) {
            // expected
        }
        System.out.println("AiClientEndpointCheck OK");
    }

    private static void assertUrl(String raw, String protocol, String expected) throws Exception {
        URL actual = AiClient.resolveEndpoint(raw, protocol);
        if (!expected.equals(actual.toString())) {
            throw new AssertionError(actual + " != " + expected);
        }
    }
}
