package com.lightreader.app;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class PdfExportBufferCheck {
    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
    }

    public static void main(String[] args) {
        PdfExportBuffer buffer = new PdfExportBuffer();
        byte[] pdf = "%PDF-1.7\nfixture\n%%EOF".getBytes(StandardCharsets.US_ASCII);
        check(!buffer.begin("doc", PdfExportBuffer.MAX_BYTES + 1), "oversized export refused");
        check(!buffer.begin("", pdf.length), "document token required");
        check(buffer.begin("doc", pdf.length), "begin export");
        check(!buffer.append("other", pdf), "stale document cannot append");
        check(buffer.append("doc", Arrays.copyOfRange(pdf, 0, 8)), "first chunk");
        check(buffer.append("doc", Arrays.copyOfRange(pdf, 8, pdf.length)), "last chunk");
        check(buffer.finish("other") == null, "stale document cannot finish");
        check(Arrays.equals(buffer.finish("doc"), pdf), "exact PDF bytes delivered");
        check(buffer.finish("doc") == null, "buffer consumed only once");
        buffer.begin("doc", pdf.length);
        buffer.append("doc", Arrays.copyOfRange(pdf, 0, 8));
        check(buffer.finish("doc") == null, "incomplete export cannot reach file picker");
        buffer.begin("doc", 8);
        check(!buffer.append("doc", pdf) && buffer.finish("doc") == null, "overflow aborts transfer");
        buffer.begin("doc", pdf.length);
        buffer.append("doc", new byte[pdf.length]);
        check(buffer.finish("doc") == null, "non-PDF rejected");
        buffer.begin("doc", pdf.length);
        buffer.cancel("doc");
        check(!buffer.append("doc", pdf), "cancel releases staging");
        buffer.begin("doc", pdf.length);
        buffer.clear();
        check(!buffer.append("doc", pdf), "document switch releases staging");
        System.out.println("PdfExportBufferCheck OK: exact chunks, stale tokens, bounds, cancellation and signature");
    }
}
