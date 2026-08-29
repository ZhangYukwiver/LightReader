package com.lightreader.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Host-side check: rendering keeps round-trip anchors, and the styled exporter
 * rewrites word/document.xml while preserving the rest of the source package.
 * Optional arg: a blocks JSON file (as produced by reader.html) to run instead
 * of the built-in sample.
 */
public final class DocxStyledExporterCheck {
    public static void main(String[] args) throws Exception {
        byte[] source = sampleDocx();

        DocxRenderer.Content content = DocxRenderer.render(source);
        if (!content.html.contains("data-style=\"Heading1\"")) {
            throw new AssertionError("渲染缺少 data-style 往返锚点");
        }
        if (!content.html.contains("data-num=\"0:5\"")) {
            throw new AssertionError("渲染缺少 data-num 往返锚点");
        }

        String blocks = args.length > 0
                ? new String(Files.readAllBytes(Path.of(args[0])), StandardCharsets.UTF_8)
                : "["
                + "{\"type\":\"p\",\"style\":\"Heading1\",\"num\":\"0:5\",\"runs\":"
                + "[{\"t\":\"标题改\",\"b\":true,\"color\":\"FF0000\",\"sz\":32}]},"
                + "{\"type\":\"p\",\"jc\":\"center\",\"indLeft\":300,\"spBefore\":150,\"fill\":\"EAF3EF\",\"runs\":"
                + "[{\"t\":\"第一行\\n第二行\",\"u\":true},{\"pb\":true},"
                + "{\"t\":\"新页 & <转义>\",\"i\":true,\"fill\":\"FFF2A8\",\"va\":\"superscript\",\"sz\":9999,\"color\":\"zzz\"}]},"
                + "{\"type\":\"table\",\"rows\":[[{\"fill\":\"C6EFCE\",\"blocks\":"
                + "[{\"type\":\"p\",\"runs\":[{\"t\":\"甲\"}]}]},{\"blocks\":[]}]]}"
                + "]";
        byte[] exported = DocxStyledExporter.write(source, blocks);

        Map<String, String> entries = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(
                new ByteArrayInputStream(exported), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                entries.put(entry.getName(), new String(zip.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        if (!entries.containsKey("word/styles.xml")) {
            throw new AssertionError("原包部件未保留");
        }
        String document = entries.get("word/document.xml");
        if (document == null) throw new AssertionError("导出缺少 document.xml");

        String[] required = {
                "<w:pStyle w:val=\"Heading1\"/>",
                "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"5\"/></w:numPr>",
                "<w:b/>", "<w:color w:val=\"FF0000\"/>", "<w:sz w:val=\"32\"/>",
                "<w:jc w:val=\"center\"/>", "<w:ind w:left=\"300\"/>",
                "<w:spacing w:before=\"150\"/>", "<w:shd w:val=\"clear\" w:fill=\"EAF3EF\"/>",
                "<w:br/>", "<w:br w:type=\"page\"/>", "<w:u w:val=\"single\"/>", "<w:i/>",
                "<w:shd w:val=\"clear\" w:fill=\"FFF2A8\"/>",
                "<w:vertAlign w:val=\"superscript\"/>",
                "新页 &amp; &lt;转义&gt;",
                "<w:tbl>", "<w:gridCol/><w:gridCol/>",
                "<w:shd w:val=\"clear\" w:fill=\"C6EFCE\"/>",
                "<w:pgSz w:w=\"11906\"", // original sectPr survives
        };
        if (args.length == 0) {
            for (String token : required) {
                if (!document.contains(token)) {
                    throw new AssertionError("导出缺少: " + token);
                }
            }
            if (document.contains("原正文占位")) throw new AssertionError("旧正文未被替换");
            if (document.contains("9999") || document.contains("zzz")) {
                throw new AssertionError("非法样式值未被拦截");
            }
            int table = document.indexOf("</w:tbl>");
            int sectPr = document.indexOf("<w:sectPr");
            if (document.indexOf("<w:p/>", table) < 0 || document.indexOf("<w:p/>", table) > sectPr) {
                throw new AssertionError("末尾表格后缺少收尾段落");
            }
        } else {
            if (!document.contains("<w:sectPr")) throw new AssertionError("sectPr 丢失");
        }
        if (args.length > 1) Files.write(Path.of(args[1]), exported);
        System.out.println("DocxStyledExporterCheck OK: " + document.length() + " chars");
    }

    private static byte[] sampleDocx() throws Exception {
        String document = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
                + "<w:body>"
                + "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/>"
                + "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"5\"/></w:numPr></w:pPr>"
                + "<w:r><w:rPr><w:b/></w:rPr><w:t>原标题</w:t></w:r></w:p>"
                + "<w:p><w:r><w:t>原正文占位</w:t></w:r></w:p>"
                + "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/></w:sectPr>"
                + "</w:body></w:document>";
        String contentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
                + "</Types>";
        String rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
                + "</Relationships>";
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            for (String[] entry : new String[][]{
                    {"[Content_Types].xml", contentTypes},
                    {"_rels/.rels", rels},
                    {"word/document.xml", document},
                    {"word/styles.xml", "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>"}}) {
                zip.putNextEntry(new ZipEntry(entry[0]));
                zip.write(entry[1].getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
        return output.toByteArray();
    }
}
