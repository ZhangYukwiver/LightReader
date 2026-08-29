package com.lightreader.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Rewrites word/document.xml from the edited reader DOM while keeping every other
 * part of the source package (styles, numbering, fonts, theme, section setup), so an
 * edited export keeps the document's look. Block JSON comes from reader.html.
 */
public final class DocxStyledExporter {
    private DocxStyledExporter() {}

    public static byte[] write(byte[] source, String blocksJson) throws Exception {
        JSONArray blocks = new JSONArray(blocksJson);
        Map<String, byte[]> entries = readEntries(source);
        byte[] documentBytes = entries.get("word/document.xml");
        if (documentBytes == null) throw new IOException("DOCX 正文缺失");
        String document = new String(documentBytes, StandardCharsets.UTF_8);
        int bodyOpen = document.indexOf("<w:body");
        int bodyStart = bodyOpen < 0 ? -1 : document.indexOf('>', bodyOpen);
        if (bodyStart < 0) throw new IOException("DOCX 正文结构无效");
        bodyStart++;
        int bodyEnd = document.lastIndexOf("<w:sectPr");
        if (bodyEnd < bodyStart) bodyEnd = document.lastIndexOf("</w:body>");
        if (bodyEnd < bodyStart) throw new IOException("DOCX 正文结构无效");
        String updated = document.substring(0, bodyStart)
                + blocksXml(blocks)
                + document.substring(bodyEnd);
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

    private static String blocksXml(JSONArray blocks) {
        StringBuilder xml = new StringBuilder(4096);
        boolean lastWasTable = appendBlocks(blocks, xml);
        // A body (and every table cell) must end with a paragraph for Word to open it.
        if (lastWasTable || blocks.length() == 0) xml.append("<w:p/>");
        return xml.toString();
    }

    /** Renders blocks and reports whether the last rendered block was a table. */
    private static boolean appendBlocks(JSONArray blocks, StringBuilder xml) {
        boolean lastWasTable = false;
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.optJSONObject(i);
            if (block == null) continue;
            if ("table".equals(block.optString("type"))) {
                table(block, xml);
                lastWasTable = true;
            } else {
                paragraph(block, xml);
                lastWasTable = false;
            }
        }
        return lastWasTable;
    }

    private static void paragraph(JSONObject block, StringBuilder xml) {
        xml.append("<w:p>");
        String props = paragraphProps(block);
        if (!props.isEmpty()) xml.append("<w:pPr>").append(props).append("</w:pPr>");
        JSONArray runs = block.optJSONArray("runs");
        if (runs != null) {
            for (int i = 0; i < runs.length(); i++) {
                JSONObject run = runs.optJSONObject(i);
                if (run != null) run(run, xml);
            }
        }
        xml.append("</w:p>");
    }

    // Child order follows the CT_PPr schema sequence.
    private static String paragraphProps(JSONObject block) {
        StringBuilder props = new StringBuilder();
        String style = block.optString("style", "");
        if (!style.isEmpty() && style.length() <= 128) {
            props.append("<w:pStyle w:val=\"").append(escape(style)).append("\"/>");
        }
        String num = block.optString("num", "");
        if (num.matches("[0-9]{1,2}:[0-9]{1,6}")) {
            String[] parts = num.split(":");
            props.append("<w:numPr><w:ilvl w:val=\"").append(parts[0])
                    .append("\"/><w:numId w:val=\"").append(parts[1]).append("\"/></w:numPr>");
        }
        String fill = hex(block.optString("fill", ""));
        if (!fill.isEmpty()) {
            props.append("<w:shd w:val=\"clear\" w:fill=\"").append(fill).append("\"/>");
        }
        int before = twips(block, "spBefore");
        int after = twips(block, "spAfter");
        if (before > 0 || after > 0) {
            props.append("<w:spacing");
            if (before > 0) props.append(" w:before=\"").append(before).append('"');
            if (after > 0) props.append(" w:after=\"").append(after).append('"');
            props.append("/>");
        }
        int left = twips(block, "indLeft");
        int right = twips(block, "indRight");
        if (left > 0 || right > 0) {
            props.append("<w:ind");
            if (left > 0) props.append(" w:left=\"").append(left).append('"');
            if (right > 0) props.append(" w:right=\"").append(right).append('"');
            props.append("/>");
        }
        String jc = block.optString("jc", "");
        if (jc.matches("left|right|center|both")) {
            props.append("<w:jc w:val=\"").append(jc).append("\"/>");
        }
        return props.toString();
    }

    private static void run(JSONObject run, StringBuilder xml) {
        if (run.optBoolean("pb")) {
            xml.append("<w:r><w:br w:type=\"page\"/></w:r>");
            return;
        }
        String text = run.optString("t", "");
        if (text.isEmpty()) return;
        xml.append("<w:r>");
        String props = runProps(run);
        if (!props.isEmpty()) xml.append("<w:rPr>").append(props).append("</w:rPr>");
        int lineStart = 0;
        for (int i = 0; i <= text.length(); i++) {
            if (i == text.length() || text.charAt(i) == '\n') {
                if (i > lineStart) {
                    xml.append("<w:t xml:space=\"preserve\">")
                            .append(escape(text.substring(lineStart, i)))
                            .append("</w:t>");
                }
                if (i < text.length()) xml.append("<w:br/>");
                lineStart = i + 1;
            }
        }
        xml.append("</w:r>");
    }

    // Child order follows the CT_RPr schema sequence.
    private static String runProps(JSONObject run) {
        StringBuilder props = new StringBuilder();
        if (run.optBoolean("b")) props.append("<w:b/>");
        if (run.optBoolean("i")) props.append("<w:i/>");
        String color = hex(run.optString("color", ""));
        if (!color.isEmpty()) props.append("<w:color w:val=\"").append(color).append("\"/>");
        int size = run.optInt("sz");
        if (size > 0 && size <= 1000) {
            props.append("<w:sz w:val=\"").append(size).append("\"/><w:szCs w:val=\"")
                    .append(size).append("\"/>");
        }
        if (run.optBoolean("u")) props.append("<w:u w:val=\"single\"/>");
        String fill = hex(run.optString("fill", ""));
        if (!fill.isEmpty()) {
            props.append("<w:shd w:val=\"clear\" w:fill=\"").append(fill).append("\"/>");
        }
        String vertical = run.optString("va", "");
        if (vertical.matches("superscript|subscript")) {
            props.append("<w:vertAlign w:val=\"").append(vertical).append("\"/>");
        }
        return props.toString();
    }

    private static void table(JSONObject block, StringBuilder xml) {
        JSONArray rows = block.optJSONArray("rows");
        if (rows == null || rows.length() == 0) return;
        int columns = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONArray cells = rows.optJSONArray(i);
            if (cells != null) columns = Math.max(columns, cells.length());
        }
        if (columns == 0) return;
        xml.append("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>");
        for (String edge : new String[]{"top", "left", "bottom", "right", "insideH", "insideV"}) {
            xml.append("<w:").append(edge)
                    .append(" w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>");
        }
        xml.append("</w:tblBorders></w:tblPr><w:tblGrid>");
        for (int i = 0; i < columns; i++) xml.append("<w:gridCol/>");
        xml.append("</w:tblGrid>");
        for (int rowIndex = 0; rowIndex < rows.length(); rowIndex++) {
            JSONArray cells = rows.optJSONArray(rowIndex);
            if (cells == null || cells.length() == 0) continue;
            xml.append("<w:tr>");
            for (int cellIndex = 0; cellIndex < cells.length(); cellIndex++) {
                JSONObject cell = cells.optJSONObject(cellIndex);
                xml.append("<w:tc><w:tcPr>");
                String fill = cell == null ? "" : hex(cell.optString("fill", ""));
                if (!fill.isEmpty()) {
                    xml.append("<w:shd w:val=\"clear\" w:fill=\"").append(fill).append("\"/>");
                }
                xml.append("</w:tcPr>");
                JSONArray cellBlocks = cell == null ? null : cell.optJSONArray("blocks");
                boolean lastWasTable = cellBlocks != null && appendBlocks(cellBlocks, xml);
                if (lastWasTable || cellBlocks == null || cellBlocks.length() == 0) {
                    xml.append("<w:p/>");
                }
                xml.append("</w:tc>");
            }
            xml.append("</w:tr>");
        }
        xml.append("</w:tbl>");
    }

    private static int twips(JSONObject block, String key) {
        int value = block.optInt(key);
        return value > 0 && value <= 100_000 ? value : 0;
    }

    private static String hex(String raw) {
        return raw.matches("[0-9A-Fa-f]{6}") ? raw.toUpperCase(java.util.Locale.ROOT) : "";
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
