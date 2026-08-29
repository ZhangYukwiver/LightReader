package com.lightreader.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** Keeps the original DOCX package and adds a visible annotation appendix. */
public final class DocxPreservingExporter {
    // ponytail: a visible appendix preserves the source package; add native Word comment
    // range parts only when true margin comments become a required export target.
    private DocxPreservingExporter() {}

    public static byte[] write(byte[] source, String documentText, List<DocxExporter.Note> sourceNotes)
            throws IOException {
        List<DocxExporter.Note> notes = validate(documentText, sourceNotes);
        Map<String, byte[]> entries = readEntries(source);
        byte[] documentBytes = entries.get("word/document.xml");
        if (documentBytes == null) throw new IOException("DOCX 正文缺失");
        String document = new String(documentBytes, StandardCharsets.UTF_8);
        int insertAt = document.lastIndexOf("<w:sectPr");
        if (insertAt < 0) insertAt = document.lastIndexOf("</w:body>");
        if (insertAt < 0) throw new IOException("DOCX 正文结构无效");
        String updated = document.substring(0, insertAt)
                + appendix(documentText, notes)
                + document.substring(insertAt);
        entries.put("word/document.xml", updated.getBytes(StandardCharsets.UTF_8));

        ByteArrayOutputStream output = new ByteArrayOutputStream(source.length + 4096);
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                zip.putNextEntry(new ZipEntry(entry.getKey()));
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return output.toByteArray();
    }

    private static Map<String, byte[]> readEntries(byte[] source) throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(source))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = zip.read(buffer)) != -1) data.write(buffer, 0, count);
                entries.put(entry.getName(), data.toByteArray());
            }
        }
        return entries;
    }

    private static List<DocxExporter.Note> validate(String text, List<DocxExporter.Note> source) {
        List<DocxExporter.Note> notes = new ArrayList<>(source);
        notes.sort(Comparator.comparingInt(note -> note.start));
        int previousEnd = 0;
        for (DocxExporter.Note note : notes) {
            if (note.start < previousEnd || note.start < 0 || note.end <= note.start
                    || note.end > text.length() || note.text == null || note.text.trim().isEmpty()) {
                throw new IllegalArgumentException("批注位置或内容无效");
            }
            previousEnd = note.end;
        }
        return notes;
    }

    private static String appendix(String documentText, List<DocxExporter.Note> notes) {
        StringBuilder xml = new StringBuilder(1024 + notes.size() * 320);
        xml.append("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>")
                .append("<w:p><w:pPr><w:shd w:fill=\"EAF3EF\"/></w:pPr>")
                .append("<w:r><w:rPr><w:b/><w:color w:val=\"2F6958\"/></w:rPr>")
                .append("<w:t>轻阅批注</w:t></w:r></w:p>");
        for (int i = 0; i < notes.size(); i++) {
            DocxExporter.Note note = notes.get(i);
            xml.append("<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">")
                    .append(escape("[" + (i + 1) + "] 原文："))
                    .append("</w:t></w:r><w:r><w:t xml:space=\"preserve\">")
                    .append(escape(documentText.substring(note.start, note.end)))
                    .append("</w:t></w:r></w:p>")
                    .append("<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>批注：</w:t></w:r>")
                    .append("<w:r><w:t xml:space=\"preserve\">")
                    .append(escape(note.text)).append("</w:t></w:r></w:p>");
        }
        return xml.toString();
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        value.codePoints().forEach(codePoint -> {
            if (codePoint == '&') escaped.append("&amp;");
            else if (codePoint == '<') escaped.append("&lt;");
            else if (codePoint == '>') escaped.append("&gt;");
            else if (codePoint == '"') escaped.append("&quot;");
            else if (codePoint == '\'') escaped.append("&apos;");
            else if (codePoint == '\t' || codePoint == '\n'
                    || (codePoint >= 0x20 && codePoint <= 0xD7FF)
                    || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
                    || (codePoint >= 0x10000 && codePoint <= 0x10FFFF)) {
                escaped.appendCodePoint(codePoint);
            }
        });
        return escaped.toString();
    }
}
