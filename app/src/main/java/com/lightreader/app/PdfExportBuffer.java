package com.lightreader.app;

import java.io.ByteArrayOutputStream;

/** Bounded, document-scoped transfer from the PDF writer to the native file picker. */
final class PdfExportBuffer {
    static final int MAX_BYTES = 40 * 1024 * 1024;
    static final int MAX_CHUNK_BYTES = 64 * 1024;
    private String token;
    private int expected;
    private ByteArrayOutputStream buffer;

    synchronized boolean begin(String documentToken, int size) {
        clear();
        if (documentToken == null || documentToken.isEmpty() || size < 8 || size > MAX_BYTES) return false;
        token = documentToken;
        expected = size;
        buffer = new ByteArrayOutputStream(Math.min(size, MAX_CHUNK_BYTES));
        return true;
    }

    synchronized boolean append(String documentToken, byte[] bytes) {
        if (buffer == null || !token.equals(documentToken)) return false;
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_CHUNK_BYTES
                || buffer.size() + bytes.length > expected) { clear(); return false; }
        buffer.write(bytes, 0, bytes.length);
        return true;
    }

    synchronized byte[] finish(String documentToken) {
        if (buffer == null || !token.equals(documentToken)) return null;
        byte[] bytes = buffer.size() == expected ? buffer.toByteArray() : null;
        clear();
        if (bytes == null || bytes[0] != '%' || bytes[1] != 'P' || bytes[2] != 'D'
                || bytes[3] != 'F' || bytes[4] != '-') return null;
        return bytes;
    }

    synchronized void cancel(String documentToken) {
        if (token != null && token.equals(documentToken)) clear();
    }

    synchronized void clear() {
        token = null;
        expected = 0;
        buffer = null;
    }
}
