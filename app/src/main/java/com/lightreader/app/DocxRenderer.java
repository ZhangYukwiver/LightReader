package com.lightreader.app;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.xml.parsers.DocumentBuilderFactory;

/** Converts the common WordprocessingML layout primitives into safe local HTML. */
public final class DocxRenderer {
    private static final String WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static final int MAX_XML_BYTES = 20 * 1024 * 1024;

    private DocxRenderer() {}

    public static final class Content {
        public final String text;
        public final String html;

        Content(String text, String html) {
            this.text = text;
            this.html = html;
        }
    }

    private static final class Buffer {
        final StringBuilder text = new StringBuilder();
        final StringBuilder html = new StringBuilder();

        void raw(String value) {
            text.append(value);
            html.append(escapeHtml(value));
        }

        Buffer fragment(String value) { html.append(value); return this; }

        void newline() { raw("\n"); }
    }

    private static final class ParagraphStyle {
        String styleName = "";
        String align = "";
        String shading = "";
        String marginLeft = "";
        String marginRight = "";
        String spacing = "";
        boolean list;
        String numRef = "";
    }

    private static final class RunStyle {
        boolean bold;
        boolean italic;
        boolean underline;
        String color = "";
        String highlight = "";
        String size = "";
        String vertical = "";

        String css() {
            StringBuilder css = new StringBuilder();
            if (bold) css.append("font-weight:700;");
            if (italic) css.append("font-style:italic;");
            if (underline) css.append("text-decoration:underline;");
            if (!color.isEmpty()) css.append("color:#").append(color).append(';');
            if (!highlight.isEmpty()) css.append("background-color:#").append(highlight).append(';');
            if (!size.isEmpty()) css.append("font-size:").append(size).append("px;");
            if ("superscript".equals(vertical)) css.append("vertical-align:super;font-size:.75em;");
            if ("subscript".equals(vertical)) css.append("vertical-align:sub;font-size:.75em;");
            return css.toString();
        }
    }

    public static Content render(byte[] docxBytes) throws Exception {
        byte[] xml = documentXml(docxBytes);
        Document document = parse(xml);
        Element body = child(document.getDocumentElement(), "body");
        if (body == null) throw new IOException("DOCX 文件中没有正文");

        Buffer buffer = new Buffer();
        List<Element> blocks = new ArrayList<>();
        for (Node node = body.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element && (is(node, "p") || is(node, "tbl"))) {
                blocks.add((Element) node);
            }
        }
        for (int i = 0; i < blocks.size(); i++) {
            Element block = blocks.get(i);
            if (is(block, "p")) paragraph(block, buffer);
            else table(block, buffer);
            if (i + 1 < blocks.size()) buffer.newline();
        }
        return new Content(buffer.text.toString(), buffer.html.toString());
    }

    private static byte[] documentXml(byte[] docxBytes) throws IOException {
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(docxBytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (!"word/document.xml".equals(entry.getName())) continue;
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int total = 0;
                int count;
                while ((count = zip.read(chunk)) != -1) {
                    total += count;
                    if (total > MAX_XML_BYTES) throw new IOException("DOCX 正文过大");
                    output.write(chunk, 0, count);
                }
                return output.toByteArray();
            }
        }
        throw new IOException("DOCX 文件中没有正文");
    }

    private static Document parse(byte[] xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        setFeature(factory, "http://apache.org/xml/features/disallow-doctype-decl", true);
        setFeature(factory, "http://xml.org/sax/features/external-general-entities", false);
        setFeature(factory, "http://xml.org/sax/features/external-parameter-entities", false);
        setFeature(factory, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        try {
            factory.setXIncludeAware(false);
        } catch (UnsupportedOperationException ignored) {
            // Android's JAXP implementation may not implement this optional JAXP 1.5 hook.
        }
        factory.setExpandEntityReferences(false);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }

    private static void setFeature(DocumentBuilderFactory factory, String name, boolean value) {
        try {
            factory.setFeature(name, value);
        } catch (Exception ignored) {
            // Android XML implementations expose slightly different feature sets.
        }
    }

    private static void paragraph(Element paragraph, Buffer buffer) {
        ParagraphStyle style = paragraphStyle(child(paragraph, "pPr"));
        buffer.fragment("<div class=\"docx-p");
        if (style.list) buffer.fragment(" docx-list");
        if (!style.styleName.isEmpty()) buffer.fragment(" docx-" + safeClass(style.styleName));
        buffer.fragment("\"");
        // Round-trip anchors: DocxStyledExporter maps these back to pStyle/numPr so an
        // edited export keeps heading styles and list numbering from the source package.
        if (!style.styleName.isEmpty()) {
            buffer.fragment(" data-style=\"").fragment(escapeHtml(style.styleName)).fragment("\"");
        }
        if (!style.numRef.isEmpty()) {
            buffer.fragment(" data-num=\"").fragment(style.numRef).fragment("\"");
        }
        buffer.fragment(" style=\"");
        buffer.fragment(paragraphCss(style));
        buffer.fragment("\">");
        renderInline(paragraph, buffer);
        buffer.fragment("</div>");
    }

    private static void renderInline(Element parent, Buffer buffer) {
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element)) continue;
            if (is(node, "r")) run((Element) node, buffer);
            else if (is(node, "hyperlink") || is(node, "smartTag") || is(node, "ins")
                    || is(node, "del")) renderInline((Element) node, buffer);
        }
    }

    private static void run(Element run, Buffer buffer) {
        RunStyle style = runStyle(child(run, "rPr"));
        String css = style.css();
        for (Node node = run.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element)) continue;
            String name = local(node);
            if ("rPr".equals(name)) continue;
            if ("t".equals(name) || "instrText".equals(name)) {
                appendStyled(buffer, node.getTextContent(), css);
            } else if ("tab".equals(name) || "ptab".equals(name)) {
                appendStyled(buffer, "\t", css);
            } else if ("br".equals(name) || "cr".equals(name)) {
                if ("page".equals(attribute((Element) node, "type"))) {
                    buffer.fragment("<span class=\"docx-page-break\"></span>");
                }
                appendStyled(buffer, "\n", css);
            } else if ("noBreakHyphen".equals(name)) {
                appendStyled(buffer, "‑", css);
            }
        }
    }

    private static void appendStyled(Buffer buffer, String text, String css) {
        if (text == null || text.isEmpty()) return;
        String normalized = text.replace("\r\n", "\n").replace('\r', '\n');
        if (css.isEmpty()) {
            buffer.raw(normalized);
        } else {
            buffer.fragment("<span style=\"").fragment(css).fragment("\">");
            buffer.raw(normalized);
            buffer.fragment("</span>");
        }
    }

    private static void table(Element table, Buffer buffer) {
        buffer.fragment("<table class=\"docx-table\"><tbody>");
        List<Element> rows = children(table, "tr");
        for (int rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
            Element row = rows.get(rowIndex);
            buffer.fragment("<tr>");
            List<Element> cells = children(row, "tc");
            for (int cellIndex = 0; cellIndex < cells.size(); cellIndex++) {
                Element cell = cells.get(cellIndex);
                buffer.fragment("<td style=\"").fragment(cellCss(child(cell, "tcPr"))).fragment("\">");
                List<Element> paragraphs = children(cell, "p");
                for (int p = 0; p < paragraphs.size(); p++) {
                    paragraph(paragraphs.get(p), buffer);
                    buffer.newline();
                }
                buffer.fragment("</td>");
            }
            buffer.fragment("</tr>");
        }
        buffer.fragment("</tbody></table>");
    }

    private static ParagraphStyle paragraphStyle(Element pPr) {
        ParagraphStyle style = new ParagraphStyle();
        if (pPr == null) return style;
        Element pStyle = child(pPr, "pStyle");
        style.styleName = attribute(pStyle, "val");
        Element jc = child(pPr, "jc");
        String align = attribute(jc, "val");
        if ("center".equals(align) || "right".equals(align) || "both".equals(align)
                || "left".equals(align)) style.align = "both".equals(align) ? "justify" : align;
        Element shd = child(pPr, "shd");
        style.shading = color(attribute(shd, "fill"));
        Element ind = child(pPr, "ind");
        style.marginLeft = twips(attribute(ind, "left"));
        style.marginRight = twips(attribute(ind, "right"));
        Element spacing = child(pPr, "spacing");
        String before = twips(attribute(spacing, "before"));
        String after = twips(attribute(spacing, "after"));
        if (!before.isEmpty()) style.spacing += "margin-top:" + before + "px;";
        if (!after.isEmpty()) style.spacing += "margin-bottom:" + after + "px;";
        Element numPr = child(pPr, "numPr");
        style.list = numPr != null;
        if (numPr != null) {
            String ilvl = attribute(child(numPr, "ilvl"), "val");
            String numId = attribute(child(numPr, "numId"), "val");
            if (numId.matches("[0-9]{1,6}")) {
                style.numRef = (ilvl.matches("[0-9]{1,2}") ? ilvl : "0") + ":" + numId;
            }
        }
        return style;
    }

    private static RunStyle runStyle(Element rPr) {
        RunStyle style = new RunStyle();
        if (rPr == null) return style;
        style.bold = child(rPr, "b") != null;
        style.italic = child(rPr, "i") != null;
        style.underline = child(rPr, "u") != null;
        style.color = color(attribute(child(rPr, "color"), "val"));
        style.highlight = highlight(attribute(child(rPr, "highlight"), "val"));
        String halfPoints = attribute(child(rPr, "sz"), "val");
        if (halfPoints.matches("[0-9]{1,3}")) {
            try {
                style.size = formatPx(Integer.parseInt(halfPoints) / 2.0 * 1.3333);
            } catch (NumberFormatException ignored) {}
        }
        String vertical = attribute(child(rPr, "vertAlign"), "val");
        if ("superscript".equals(vertical) || "subscript".equals(vertical)) style.vertical = vertical;
        return style;
    }

    private static String paragraphCss(ParagraphStyle style) {
        StringBuilder css = new StringBuilder();
        if (!style.align.isEmpty()) css.append("text-align:").append(style.align).append(';');
        if (!style.marginLeft.isEmpty()) css.append("margin-left:").append(style.marginLeft).append("px;");
        if (!style.marginRight.isEmpty()) css.append("margin-right:").append(style.marginRight).append("px;");
        css.append(style.spacing);
        if (!style.shading.isEmpty()) css.append("background-color:#").append(style.shading).append(';');
        if ("Heading1".equalsIgnoreCase(style.styleName)) css.append("font-size:1.45em;font-weight:700;margin-top:1em;");
        if ("Heading2".equalsIgnoreCase(style.styleName)) css.append("font-size:1.2em;font-weight:700;margin-top:.8em;");
        if ("Title".equalsIgnoreCase(style.styleName)) css.append("font-size:1.7em;font-weight:700;");
        if ("Subtitle".equalsIgnoreCase(style.styleName)) css.append("font-size:1.05em;color:var(--muted);");
        return css.toString();
    }

    private static String cellCss(Element tcPr) {
        if (tcPr == null) return "";
        String fill = color(attribute(child(tcPr, "shd"), "fill"));
        return fill.isEmpty() ? "" : "background-color:#" + fill + ';';
    }

    private static String twips(String raw) {
        if (!raw.matches("-?[0-9]{1,6}")) return "";
        try { return formatPx(Double.parseDouble(raw) / 15.0); }
        catch (NumberFormatException ignored) { return ""; }
    }

    private static String color(String raw) {
        return raw != null && raw.matches("[0-9A-Fa-f]{6}") && !"auto".equalsIgnoreCase(raw)
                ? raw.toUpperCase(Locale.ROOT) : "";
    }

    private static String highlight(String raw) {
        if (raw == null) return "";
        switch (raw.toLowerCase(Locale.ROOT)) {
            case "yellow": return "FFF2A8";
            case "green": return "C6EFCE";
            case "cyan": return "C6EAF2";
            case "magenta": return "F4CCCC";
            case "blue": return "C9DAF8";
            case "red": return "F4CCCC";
            default: return color(raw);
        }
    }

    private static String formatPx(double value) {
        return String.format(Locale.ROOT, "%.2f", value).replaceAll("\\.00$", "");
    }

    private static String safeClass(String raw) {
        return raw.replaceAll("[^A-Za-z0-9_-]", "");
    }

    private static String escapeHtml(String raw) {
        StringBuilder out = new StringBuilder(raw.length() + 16);
        raw.codePoints().forEach(codePoint -> {
            if (codePoint == '&') out.append("&amp;");
            else if (codePoint == '<') out.append("&lt;");
            else if (codePoint == '>') out.append("&gt;");
            else if (codePoint == '"') out.append("&quot;");
            else if (codePoint == '\'') out.append("&#39;");
            else out.appendCodePoint(codePoint);
        });
        return out.toString();
    }

    private static boolean is(Node node, String name) { return name.equals(local(node)); }

    private static String local(Node node) {
        String name = node.getLocalName();
        if (name != null) return name;
        name = node.getNodeName();
        int colon = name.indexOf(':');
        return colon >= 0 ? name.substring(colon + 1) : name;
    }

    private static String attribute(Element element, String name) {
        if (element == null) return "";
        String value = element.getAttributeNS(WORD_NS, name);
        if (value == null || value.isEmpty()) value = element.getAttribute("w:" + name);
        if (value == null || value.isEmpty()) value = element.getAttribute(name);
        return value == null ? "" : value;
    }

    private static Element child(Element parent, String name) {
        if (parent == null) return null;
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element && is(node, name)) return (Element) node;
        }
        return null;
    }

    private static List<Element> children(Element parent, String name) {
        List<Element> result = new ArrayList<>();
        if (parent == null) return result;
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element && is(node, name)) result.add((Element) node);
        }
        return result;
    }
}
