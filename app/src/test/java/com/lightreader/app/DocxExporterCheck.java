package com.lightreader.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class DocxExporterCheck {
    public static void main(String[] args) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        DocxExporter.write(output, "第一行\n需要批注的文字 & <测试>",
                List.of(new DocxExporter.Note(4, 10, "这是批注 & 检查", 1_700_000_000_000L)));

        boolean documentFound = false;
        boolean commentsFound = false;
        try (ZipInputStream zip = new ZipInputStream(
                new java.io.ByteArrayInputStream(output.toByteArray()), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String xml = new String(zip.readAllBytes(), StandardCharsets.UTF_8);
                if (entry.getName().equals("word/document.xml")) {
                    documentFound = xml.contains("w:commentRangeStart") && xml.contains("&amp;");
                }
                if (entry.getName().equals("word/comments.xml")) {
                    commentsFound = xml.contains("这是批注 &amp; 检查");
                }
            }
        }
        if (!documentFound || !commentsFound) throw new AssertionError("DOCX 批注结构缺失");
        if (args.length == 1) Files.write(Path.of(args[0]), output.toByteArray());
        System.out.println("DocxExporterCheck OK");
    }
}
