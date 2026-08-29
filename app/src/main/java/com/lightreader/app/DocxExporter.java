package com.lightreader.app;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public final class DocxExporter {
    private DocxExporter() {}

    public static final class Note {
        public final int start;
        public final int end;
        public final String text;
        public final long createdAt;

        public Note(int start, int end, String text, long createdAt) {
            this.start = start;
            this.end = end;
            this.text = text;
            this.createdAt = createdAt;
        }
    }

    public static void write(OutputStream output, String documentText, List<Note> sourceNotes)
            throws IOException {
        List<Note> notes = validate(documentText, sourceNotes);
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            entry(zip, "[Content_Types].xml", contentTypes());
            entry(zip, "_rels/.rels", packageRelationships());
            entry(zip, "word/document.xml", documentXml(documentText, notes));
            entry(zip, "word/_rels/document.xml.rels", documentRelationships());
            entry(zip, "word/comments.xml", commentsXml(notes));
        }
    }

    private static List<Note> validate(String text, List<Note> source) {
        List<Note> notes = new ArrayList<>(source);
        notes.sort(Comparator.comparingInt(note -> note.start));
        int previousEnd = 0;
        for (Note note : notes) {
            if (note.start < previousEnd || note.start < 0 || note.end <= note.start
                    || note.end > text.length() || note.text == null || note.text.trim().isEmpty()) {
                throw new IllegalArgumentException("批注位置或内容无效");
            }
            previousEnd = note.end;
        }
        return notes;
    }

    private static String contentTypes() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
                + "<Override PartName=\"/word/comments.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml\"/>"
                + "</Types>";
    }

    private static String packageRelationships() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
                + "</Relationships>";
    }

    private static String documentRelationships() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments\" Target=\"comments.xml\"/>"
                + "</Relationships>";
    }

    private static String documentXml(String text, List<Note> notes) {
        StringBuilder xml = new StringBuilder(4096 + text.length());
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>")
                .append("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p>");
        int cursor = 0;
        for (int id = 0; id < notes.size(); id++) {
            Note note = notes.get(id);
            appendText(xml, text.substring(cursor, note.start));
            xml.append("<w:commentRangeStart w:id=\"").append(id).append("\"/>");
            appendText(xml, text.substring(note.start, note.end));
            xml.append("<w:commentRangeEnd w:id=\"").append(id).append("\"/>")
                    .append("<w:r><w:commentReference w:id=\"").append(id).append("\"/></w:r>");
            cursor = note.end;
        }
        appendText(xml, text.substring(cursor));
        xml.append("</w:p><w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>")
                .append("<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/>")
                .append("</w:sectPr></w:body></w:document>");
        return xml.toString();
    }

    private static String commentsXml(List<Note> notes) {
        StringBuilder xml = new StringBuilder(1024 + notes.size() * 256);
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>")
                .append("<w:comments xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">");
        for (int id = 0; id < notes.size(); id++) {
            Note note = notes.get(id);
            Instant date = note.createdAt > 0 ? Instant.ofEpochMilli(note.createdAt) : Instant.now();
            xml.append("<w:comment w:id=\"").append(id)
                    .append("\" w:author=\"轻阅\" w:initials=\"QY\" w:date=\"")
                    .append(date).append("\"><w:p><w:r><w:t xml:space=\"preserve\">")
                    .append(escape(note.text)).append("</w:t></w:r></w:p></w:comment>");
        }
        return xml.append("</w:comments>").toString();
    }

    private static void appendText(StringBuilder xml, String text) {
        int lineStart = 0;
        for (int i = 0; i <= text.length(); i++) {
            if (i == text.length() || text.charAt(i) == '\n') {
                if (i > lineStart) {
                    xml.append("<w:r><w:t xml:space=\"preserve\">")
                            .append(escape(text.substring(lineStart, i)))
                            .append("</w:t></w:r>");
                }
                if (i < text.length()) {
                    xml.append("<w:r><w:br/></w:r>");
                }
                lineStart = i + 1;
            }
        }
    }

    private static String escape(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        value.codePoints().forEach(codePoint -> {
            if (codePoint == '&') escaped.append("&amp;");
            else if (codePoint == '<') escaped.append("&lt;");
            else if (codePoint == '>') escaped.append("&gt;");
            else if (codePoint == '\"') escaped.append("&quot;");
            else if (codePoint == '\'') escaped.append("&apos;");
            else if (codePoint == '\t'
                    || (codePoint >= 0x20 && codePoint <= 0xD7FF)
                    || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
                    || (codePoint >= 0x10000 && codePoint <= 0x10FFFF)) {
                escaped.appendCodePoint(codePoint);
            }
        });
        return escaped.toString();
    }

    private static void entry(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }
}
