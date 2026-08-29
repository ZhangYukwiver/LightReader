package com.lightreader.app;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipInputStream;
import java.io.ByteArrayInputStream;

/** Host-side check that an annotated DOCX keeps its original package parts. */
public final class DocxPreservingExporterCheck {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) throw new IllegalArgumentException("需要 DOCX 路径");
        byte[] source = Files.readAllBytes(Path.of(args[0]));
        DocxRenderer.Content content = DocxRenderer.render(source);
        int end = Math.min(content.text.length(), Math.max(1, content.text.indexOf('。') + 1));
        byte[] output = DocxPreservingExporter.write(source, content.text,
                List.of(new DocxExporter.Note(0, end, "检查原格式保留", 0)));
        if (args.length > 1) Files.write(Path.of(args[1]), output);
        boolean originalStyle = false;
        boolean table = false;
        boolean appendix = false;
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(output))) {
            java.util.zip.ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (!"word/document.xml".equals(entry.getName())) continue;
                String xml = new String(zip.readAllBytes(), StandardCharsets.UTF_8);
                originalStyle = xml.contains("w:pStyle") || xml.contains("w:rPr");
                table = xml.contains("<w:tbl");
                appendix = xml.contains("轻阅批注") && xml.contains("检查原格式保留");
            }
        }
        if (!originalStyle || !table || !appendix) throw new AssertionError("DOCX 原格式或批注附录缺失");
        System.out.println("DocxPreservingExporterCheck OK");
    }
}
